/* ===========================================================
   beat-timer.js — "Beat Timer": listens to a REAL pendulum
   clock through the microphone and measures how many seconds
   per day it's running fast or slow, so the pendulum can be
   adjusted to correct it. Entirely independent of the simulated
   clock in clock.js/main.js — opens as a full-screen view over
   the dial and doesn't touch the going-train/chime simulation,
   beyond briefly muting ChimeAudio while open so the simulated
   tick can't contaminate the microphone measurement.

   Detection happens in js/beat-processor.js (an AudioWorklet
   running on the real-time audio thread for sample-accurate
   timestamps); this module turns the resulting beat timestamps
   into a live rate/drift estimate via linear regression.
   =========================================================== */

(() => {
  const STORE_KEY = 'gfclock.beatTimer.settings';
  const DAY_SEC = 86400;
  const MAX_GAP_BEATS = 20;      // gap this large (in estimated beats) = session restart
  const OUTLIER_FRAC = 0.25;     // reject if a raw interval is off by more than this fraction of T_est
  const MEDIAN_WINDOW = 21;      // recent intervals kept for the running T_est median

  const defaults = { targetBpm: 60 };
  const settings = Object.assign({}, defaults, load());

  const params = new URLSearchParams(location.search);
  if (params.has('beatbpm')) {
    const v = Number(params.get('beatbpm'));
    if (v > 0) settings.targetBpm = v;
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  }

  /* ---- Session state: accepted-beat regression stats ---- */
  let session = null;
  function newSession(targetBpm) {
    return {
      tEst: 60 / targetBpm,       // running robust seconds/beat estimate, seeded from target
      recentIntervals: [],        // per-beat intervals (deltaT/n), for the median T_est
      lastT: null,                // last accepted beat's audio-clock timestamp
      k: 0,                       // current beat index
      firstT: null, lastAcceptedT: null,
      n: 0, Sk: 0, St: 0, Skk: 0, Skt: 0, Stt: 0, // OLS running sums over (k, t)
      restarted: false,
    };
  }

  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /* Feed one raw detected-beat timestamp (audio-clock seconds) into the
     session: reject duplicates/outliers, detect long gaps as a session
     restart, and fold accepted beats into the running OLS sums. */
  function acceptBeat(t) {
    if (session.lastT === null) {
      session.lastT = t;
      session.firstT = t;
      session.lastAcceptedT = t;
      session.k = 0;
      addPoint(0, t);
      return true;
    }
    const deltaT = t - session.lastT;
    const n = Math.round(deltaT / session.tEst);

    if (n === 0) return false; // duplicate / re-trigger on the same click

    if (n > MAX_GAP_BEATS) {
      // Long silence (mic moved, clock stopped, big pause) — start a fresh
      // segment rather than let a huge gap poison the regression.
      const tBpm = 60 / session.tEst;
      session = newSession(tBpm);
      session.restarted = true;
      session.lastT = t;
      session.firstT = t;
      session.lastAcceptedT = t;
      session.k = 0;
      addPoint(0, t);
      return true;
    }

    const expected = n * session.tEst;
    if (Math.abs(deltaT - expected) > OUTLIER_FRAC * session.tEst) return false; // noise/outlier

    session.k += n;
    session.lastT = t;
    session.lastAcceptedT = t;
    addPoint(session.k, t);

    // Refine the robust period estimate from the median of recent per-beat intervals.
    const perBeat = deltaT / n;
    session.recentIntervals.push(perBeat);
    if (session.recentIntervals.length > MEDIAN_WINDOW) session.recentIntervals.shift();
    session.tEst = median(session.recentIntervals);
    return true;
  }

  function addPoint(k, t) {
    session.n++;
    session.Sk += k; session.St += t;
    session.Skk += k * k; session.Skt += k * t; session.Stt += t * t;
  }

  /* Ordinary least-squares fit of t = a + b*k over all accepted points so
     far. b (seconds/beat) is the true measured rate; using every beat as
     one regression point (rather than averaging consecutive intervals) is
     robust to reindexed missed beats and tightens with the session's time
     span, not just its beat count. */
  function fitRate() {
    const { n, Sk, St, Skk, Skt, Stt } = session;
    if (n < 3) return null;
    const meanK = Sk / n, meanT = St / n;
    const SkkC = Skk - (Sk * Sk) / n;
    const SktC = Skt - (Sk * St) / n;
    const SttC = Stt - (St * St) / n;
    if (SkkC <= 0) return null;
    const b = SktC / SkkC;               // measured seconds/beat
    const a = meanT - b * meanK;
    const sse = Math.max(0, SttC - b * SktC);
    const dof = n - 2;
    const seB = dof > 0 ? Math.sqrt((sse / dof) / SkkC) : null;
    return { a, b, seB, n };
  }

  function computeReadout() {
    const fit = fitRate();
    const targetBpm = settings.targetBpm;
    if (!fit || fit.b <= 0) return null;
    const measuredBpm = 60 / fit.b;
    const secPerDayDrift = DAY_SEC * (measuredBpm / targetBpm - 1);
    let seSecPerDay = null;
    if (fit.seB != null) {
      seSecPerDay = (DAY_SEC * 60 / (targetBpm * fit.b * fit.b)) * fit.seB;
    }
    const durationSec = session.lastAcceptedT - session.firstT;
    return { measuredBpm, secPerDayDrift, seSecPerDay, beatCount: fit.n, durationSec, restarted: session.restarted };
  }

  /* ---- Microphone / worklet plumbing ---- */
  let audioCtx = null, micStream = null, workletNode = null, sourceNode = null;
  let listening = false;
  let levelHistory = []; // ring buffer of {env, floor, thr} for the meter
  const LEVEL_HISTORY_MAX = 120;

  function availability() {
    if (!window.isSecureContext) {
      return { ok: false, msg: 'Microphone access needs a secure connection (HTTPS or localhost) — the plain http://<LAN-IP> address won’t work for this feature, though the simulated clock still will.' };
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { ok: false, msg: 'This browser doesn’t support microphone access.' };
    }
    if (!window.AudioWorklet) {
      return { ok: false, msg: 'This browser doesn’t support the audio processing this feature needs.' };
    }
    return { ok: true, msg: 'Hold this device near the clock, keep the room quiet, and press Start Listening.' };
  }

  async function startListening() {
    const avail = availability();
    if (!avail.ok) { setStatus(avail.msg, true); return; }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      setStatus(mapMicError(err), true);
      return;
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      await audioCtx.audioWorklet.addModule('js/beat-processor.js');
    } catch (err) {
      setStatus('Couldn’t load the audio processor: ' + err.message, true);
      stopListening();
      return;
    }

    sourceNode = audioCtx.createMediaStreamSource(micStream);
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1000; hp.Q.value = 0.7;
    const hp2 = audioCtx.createBiquadFilter();
    hp2.type = 'highpass'; hp2.frequency.value = 1000; hp2.Q.value = 0.7;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 8000; lp.Q.value = 0.7;

    workletNode = new AudioWorkletNode(audioCtx, 'beat-detector');
    workletNode.port.onmessage = (e) => onWorkletMessage(e.data);
    workletNode.port.postMessage({ type: 'config', targetBpm: settings.targetBpm });

    sourceNode.connect(hp);
    hp.connect(hp2);
    hp2.connect(lp);
    lp.connect(workletNode);
    // Intentionally not connected to audioCtx.destination — this is
    // analysis only, not monitoring, so nothing plays back.

    resetSession();
    listening = true;
    updateStartStopUI();
    setStatus('Listening… waiting for the first tick.', false);
  }

  function stopListening() {
    listening = false;
    if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    updateStartStopUI();
    setStatus(availability().msg, false);
  }

  function mapMicError(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access was denied — allow it in your browser’s site settings and try again.';
      case 'NotFoundError':
        return 'No microphone was found on this device.';
      case 'NotReadableError':
        return 'Couldn’t start the microphone — it may be in use by another app.';
      default:
        return 'Couldn’t access the microphone (' + ((err && err.message) || 'unknown error') + ').';
    }
  }

  function resetSession() {
    session = newSession(settings.targetBpm);
    levelHistory = [];
    updateReadout();
    drawMeter();
  }

  function onWorkletMessage(msg) {
    if (msg.type === 'beat') {
      flashPulse();
      acceptBeat(msg.t);
      updateReadout();
    } else if (msg.type === 'level') {
      levelHistory.push(msg);
      if (levelHistory.length > LEVEL_HISTORY_MAX) levelHistory.shift();
      drawMeter();
    }
  }

  /* ===================== UI ===================== */
  const el = {};
  function cacheUI() {
    el.beatBtn = document.getElementById('beatBtn');
    el.beatView = document.getElementById('beatView');
    el.closeBeatView = document.getElementById('closeBeatView');
    el.bpmSeg = document.getElementById('bpmSeg');
    el.bpmCustom = document.getElementById('bpmCustom');
    el.startStopBtn = document.getElementById('beatStartStop');
    el.resetBtn = document.getElementById('beatReset');
    el.statusHint = document.getElementById('beatStatus');
    el.pulse = document.getElementById('beatPulse');
    el.meter = document.getElementById('beatWave');
    el.roBpm = document.getElementById('roBpm');
    el.roDrift = document.getElementById('roDrift');
    el.roConfidence = document.getElementById('roConfidence');
    el.roSession = document.getElementById('roSession');
    el.roHint = document.getElementById('roHint');
  }

  function setActiveBpmPreset(bpm) {
    el.bpmSeg.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.bpm) === bpm);
    });
  }

  function applyTargetBpm(bpm, fromCustom) {
    bpm = Math.max(10, Math.min(300, Number(bpm) || 60));
    settings.targetBpm = bpm;
    if (!fromCustom) el.bpmCustom.value = '';
    setActiveBpmPreset(bpm);
    save();
    if (workletNode) workletNode.port.postMessage({ type: 'config', targetBpm: bpm });
    updateReadout();
  }

  function setStatus(msg, isError) {
    el.statusHint.textContent = msg;
    el.statusHint.classList.toggle('error', !!isError);
  }

  function updateStartStopUI() {
    el.startStopBtn.textContent = listening ? 'Stop Listening' : 'Start Listening';
    el.startStopBtn.classList.toggle('active', listening);
    const avail = availability();
    el.startStopBtn.disabled = !listening && !avail.ok;
  }

  function flashPulse() {
    el.pulse.classList.remove('flash');
    void el.pulse.offsetWidth; // restart animation
    el.pulse.classList.add('flash');
  }

  function fmtSec(s) {
    s = Math.round(s);
    const m = Math.floor(s / 60), r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  function confidenceLabel(seSecPerDay) {
    if (seSecPerDay == null) return { label: '—', cls: '' };
    if (seSecPerDay < 1) return { label: 'High', cls: 'good' };
    if (seSecPerDay < 5) return { label: 'Medium', cls: '' };
    return { label: 'Low', cls: 'warn' };
  }

  function updateReadout() {
    const r = session ? computeReadout() : null;
    if (!r) {
      el.roBpm.textContent = '—';
      el.roDrift.textContent = '—';
      el.roConfidence.textContent = '—';
      el.roSession.textContent = session ? `0 beats · 0:00` : '—';
      el.roHint.textContent = 'Listening for ticks… the readout appears after a few beats.';
      return;
    }
    el.roBpm.textContent = r.measuredBpm.toFixed(2) + ' BPM';
    const fast = r.secPerDayDrift > 0;
    el.roDrift.textContent = (fast ? '+' : '') + r.secPerDayDrift.toFixed(1) + ' s/day';
    el.roDrift.classList.toggle('good', Math.abs(r.secPerDayDrift) < 2);
    el.roDrift.classList.toggle('warn', Math.abs(r.secPerDayDrift) >= 2);
    const conf = confidenceLabel(r.seSecPerDay);
    el.roConfidence.textContent = conf.label + (r.seSecPerDay != null ? ` (±${r.seSecPerDay.toFixed(1)} s/day)` : '');
    el.roConfidence.className = 'ro-value ' + conf.cls;
    el.roSession.textContent = `${r.beatCount} beats · ${fmtSec(r.durationSec)}`;

    let hint;
    if (Math.abs(r.secPerDayDrift) < 1.5) {
      hint = 'Close enough — the clock is keeping good time.';
    } else if (fast) {
      hint = `Running fast — lengthen the pendulum (lower the bob) slightly to slow it down.`;
    } else {
      hint = `Running slow — shorten the pendulum (raise the bob) slightly to speed it up.`;
    }
    if (r.restarted) hint += ' (Session restarted after a long pause — keep listening for a steadier reading.)';
    el.roHint.textContent = hint;
  }

  function drawMeter() {
    const ctx = el.meter.getContext('2d');
    const w = el.meter.width, h = el.meter.height;
    ctx.clearRect(0, 0, w, h);
    if (!levelHistory.length) return;
    const last = levelHistory[levelHistory.length - 1];
    const scale = Math.max(last.threshold * 3, 0.01);
    ctx.strokeStyle = 'rgba(217,177,74,0.9)'; // brass, matches theme
    ctx.lineWidth = 2;
    ctx.beginPath();
    levelHistory.forEach((s, i) => {
      const x = (i / (LEVEL_HISTORY_MAX - 1)) * w;
      const y = h - Math.min(1, s.envelope / scale) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // Threshold reference line.
    const thrY = h - Math.min(1, last.threshold / scale) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, thrY); ctx.lineTo(w, thrY); ctx.stroke();
    ctx.setLineDash([]);
  }

  let prevMuted = false;
  function openView() {
    prevMuted = ChimeAudio.getMuted();
    ChimeAudio.setMuted(true); // keep the simulated tick from contaminating the mic
    el.beatView.classList.add('open');
    el.beatView.setAttribute('aria-hidden', 'false');
    setStatus(availability().msg, !availability().ok);
    updateStartStopUI();
  }

  function closeView() {
    el.beatView.classList.remove('open');
    el.beatView.setAttribute('aria-hidden', 'true');
    if (listening) stopListening();
    ChimeAudio.setMuted(prevMuted);
  }

  function bind() {
    el.beatBtn.addEventListener('click', openView);
    el.closeBeatView.addEventListener('click', closeView);

    el.bpmSeg.addEventListener('click', (e) => {
      if (e.target.dataset.bpm) applyTargetBpm(Number(e.target.dataset.bpm), false);
    });
    el.bpmCustom.addEventListener('change', () => {
      if (el.bpmCustom.value) applyTargetBpm(Number(el.bpmCustom.value), true);
    });

    el.startStopBtn.addEventListener('click', () => {
      if (listening) stopListening(); else startListening();
    });
    el.resetBtn.addEventListener('click', resetSession);
  }

  function hydrate() {
    setActiveBpmPreset(settings.targetBpm);
    if (![30, 60, 120].includes(settings.targetBpm)) el.bpmCustom.value = settings.targetBpm;
    updateStartStopUI();
    setStatus(availability().msg, !availability().ok);
  }

  document.addEventListener('DOMContentLoaded', () => {
    cacheUI();
    bind();
    hydrate();
    if (params.get('view') === 'beat') openView();
  });
})();
