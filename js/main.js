/* ===========================================================
   main.js — settings, chime scheduling, night silence, theme,
   persistence. Ties the UI drawer to Clock + ChimeAudio.
   =========================================================== */

(() => {
  const STORE_KEY = 'gfclock.settings';

  const defaults = {
    theme: 'light',
    cloudDensity: 20, // percent; 20% == the four original clouds
    chime: 'westminster',
    muted: false,
    volume: 70,
    nightSilence: true,
    showSeconds: true,
    tick: true,
    tickVolume: 60,
    chimeTempo: 100, // percent; 100 = normal, lower = slower/more spacious
    phraseGap: 1.0,  // seconds of silence between chime phrases
    strikeGap: 1.5,  // seconds between hour strikes
    screensaverMin: 5, // idle minutes before the cloud screensaver (0 = off)
    speed: 1,
  };

  const settings = Object.assign({}, defaults, load());

  // URL query overrides (handy for deep-linked testing, e.g. ?theme=auto&speed=3600&time=11:59)
  const params = new URLSearchParams(location.search);
  if (params.has('theme')) settings.theme = params.get('theme');
  if (params.has('clouds')) settings.cloudDensity = Number(params.get('clouds'));
  if (params.has('chime')) settings.chime = params.get('chime');
  if (params.has('speed')) settings.speed = Number(params.get('speed')) || settings.speed;
  if (params.has('tempo')) settings.chimeTempo = Number(params.get('tempo')) || settings.chimeTempo;
  if (params.has('gap')) settings.phraseGap = Number(params.get('gap'));
  if (params.has('strikegap')) settings.strikeGap = Number(params.get('strikegap'));
  if (params.has('screensaver')) settings.screensaverMin = Number(params.get('screensaver'));

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  }

  // ---- Screensaver (idle clouds) ----
  let lastActivityAt = Date.now();
  let screensaverActive = false;

  function onActivity() {
    lastActivityAt = Date.now();
    if (screensaverActive) {        // any interaction dismisses it
      screensaverActive = false;
      Clock.setScreensaver(false);
    }
  }
  function checkIdle() {
    const mins = settings.screensaverMin;
    if (screensaverActive || !(mins > 0)) return;
    if (Date.now() - lastActivityAt >= mins * 60000) {
      screensaverActive = true;
      Clock.setScreensaver(true);
    }
  }

  // ---- Chime scheduling state ----
  // Track the last quarter index we chimed so we fire exactly once per quarter.
  let lastQuarterKey = null;
  let lastTickSec = null; // absolute floored second, for the per-second tick sound
  const AUDIO_SPEED_LIMIT = 4; // above this, suppress audio (visual flash only)

  // ---- Weights ----
  // Each weight's `drop` runs 0 (fully wound, at the top) -> 1 (fully run down).
  // The TIME (going) weight descends slowly and continuously — a full drop takes
  // 8 days. The STRIKE and CHIME trains do far more work, in short bursts, so
  // their weights descend visibly during each strike/chime and run down much
  // faster: a full drop in roughly ONE day of normal operation (~8x the time
  // weight's rate). The per-event amount stays proportional to the work (gong
  // count / chime phrases).
  const DAY_MS = 86400000;
  const FULL_WIND_MS = 8 * DAY_MS;   // time weight: top -> bottom in 8 days
  const UNIT_STRIKE = 1 / 156;       // per gong   (~156 gongs/day -> full drop in a day)
  const UNIT_CHIME  = 1 / 240;       // per phrase (10 phrases/hr * 24 -> full drop in a day)
  const WIND_FULL_MS = 6000;         // real ms to wind a full run-down up to the top
  const CABLE_MIN = 16;              // cable length (px) when fully wound
  let weightTravel = 600;            // px of travel, measured at init
  const weight = {
    time:   { el: null, drop: 0.50, winding: false },
    strike: { el: null, drop: 0.40, winding: false, descendLeft: 0, descendRate: 0 },
    chime:  { el: null, drop: 0.60, winding: false, descendLeft: 0, descendRate: 0 },
  };
  // While winding, play the tick (ratchet) sound 4×/second.
  const WIND_TICK_MS = 250;
  let windTickAccum = 0;

  function initWeights() {
    weight.time.el   = document.getElementById('wTime');
    weight.strike.el = document.getElementById('wStrike');
    weight.chime.el  = document.getElementById('wChime');
    const door = document.querySelector('.glass-door');
    // Measure the non-cable height of a weight (pulley + hook + bob) at the
    // minimum cable, then size the travel to the available door height.
    for (const k in weight) weight[k].el.style.setProperty('--cable', CABLE_MIN + 'px');
    const baseFixed = weight.time.el.offsetHeight - CABLE_MIN;
    const avail = door.clientHeight - 16; // 8px headroom top + bottom
    weightTravel = Math.max(120, avail - baseFixed - CABLE_MIN);
    // Cache the rotating sheave (spokes) and each pulley's diameter so the
    // sheave can roll on the cable: one circumference per π·d of travel.
    for (const k in weight) {
      const w = weight[k];
      w.spokes = w.el.querySelector('.spokes');
      const pulley = w.el.querySelector('.pulley');
      w.pulleyDiam = pulley ? pulley.offsetWidth : 34; // px
    }
    applyWeights();
  }

  function applyWeights() {
    for (const k in weight) {
      const w = weight[k];
      const drop = Math.max(0, Math.min(1, w.drop));
      const descent = drop * weightTravel;           // px the sheave has dropped
      const cable = CABLE_MIN + descent;
      w.el.style.setProperty('--cable', cable.toFixed(1) + 'px');
      // Roll without slipping on the cable: a full turn per circumference of
      // travel. Positive (clockwise) as it runs down; so winding up turns it
      // counter-clockwise.
      if (w.spokes) {
        const deg = (descent / (Math.PI * w.pulleyDiam)) * 360;
        w.spokes.style.transform = `translate(-50%, -50%) rotate(${deg.toFixed(2)}deg)`;
      }
    }
  }

  /* Make a weight descend by `amount` (drop units) spread over `durationSec`
     of real time — i.e. only while its train is actually running (chiming or
     striking). Overlapping calls accumulate. */
  function scheduleDescent(which, amount, durationSec) {
    const w = weight[which];
    if (!w || amount <= 0) return;
    w.descendLeft += amount;
    w.descendRate = durationSec > 0 ? w.descendLeft / durationSec : w.descendLeft; // units/sec
  }

  function setWinding(which, on) {
    if (weight[which]) weight[which].winding = on;
  }

  function updateWeights(dtSim, dtReal) {
    // The going (time) train always runs (unless we're actively winding it).
    if (!weight.time.winding) {
      weight.time.drop = Math.min(1, weight.time.drop + dtSim / FULL_WIND_MS);
    }
    // The strike/chime weights descend ONLY while their train is running — i.e.
    // while there's scheduled descent left from an active chime/strike.
    for (const k of ['strike', 'chime']) {
      const w = weight[k];
      if (w.winding || w.descendLeft <= 0) continue;
      const step = Math.min(w.descendLeft, w.descendRate * (dtReal / 1000));
      w.drop = Math.min(1, w.drop + step);
      w.descendLeft -= step;
    }
    // Winding pulls a weight back up to the top at a steady real-time rate.
    let anyWinding = false;
    for (const k in weight) {
      const w = weight[k];
      if (w.winding) {
        anyWinding = true;
        w.drop -= dtReal / WIND_FULL_MS;
        if (w.drop <= 0) { w.drop = 0; w.winding = false; }
        if (w.descendLeft) w.descendLeft = 0; // winding cancels any pending descent
      }
    }
    applyWeights();

    // Ratchet: play the tick sound 4×/second while any weight is winding.
    if (anyWinding) {
      windTickAccum += dtReal;
      while (windTickAccum >= WIND_TICK_MS) {
        windTickAccum -= WIND_TICK_MS;
        if (!settings.muted) ChimeAudio.playTick();
      }
    } else {
      windTickAccum = 0;
    }
  }

  /* Returns true if the simulated time falls in the night-silence window. */
  function isNightSilenced(date) {
    if (!settings.nightSilence) return false;
    const mins = date.getHours() * 60 + date.getMinutes();
    const start = 22 * 60 + 15; // 10:15 PM
    const end = 7 * 60 + 15;    // 7:15 AM
    return mins >= start || mins < end;
  }

  function flashDial(durationMs) {
    const frame = document.querySelector('.dial-frame');
    frame.classList.remove('flash');
    void frame.offsetWidth; // restart animation
    frame.classList.add('flash');
  }

  /* Called every frame by the clock with the current simulated Date and the
     elapsed simulated/real ms since the previous frame. */
  function onTick(date, speed, dtSim, dtReal) {
    updateWeights(dtSim || 0, dtReal || 0);

    const h = date.getHours();
    const m = date.getMinutes();
    const quarter = Math.floor(m / 15); // 0,1,2,3
    // Key identifies a unique quarter-hour occurrence.
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${h}-${quarter}`;

    if (lastQuarterKey === null) {
      // First frame: don't chime, just record where we are.
      lastQuarterKey = key;
    } else if (key !== lastQuarterKey) {
      lastQuarterKey = key;
      fireChime(date, quarter, speed);
    }

    // Per-second escapement tick. Ticks 24/7 (night silence only affects chimes),
    // but respects mute, the tick toggle, and the fast-forward audio limit.
    const sec = Math.floor(date.getTime() / 1000);
    if (lastTickSec === null) {
      lastTickSec = sec;
    } else if (sec !== lastTickSec) {
      lastTickSec = sec;
      if (settings.tick && !settings.muted && speed <= AUDIO_SPEED_LIMIT) {
        ChimeAudio.playTick();
      }
    }

    // Live readout in the drawer
    el.bigTime.textContent = date.toLocaleTimeString();
    el.speedReadout.textContent = speed === 1
      ? '1× (real time)'
      : `${speed}× speed${speed > AUDIO_SPEED_LIMIT ? ' — chimes muted' : ''}`;
  }

  function fireChime(date, quarter, speed) {
    if (settings.chime === 'silent') return;

    // The chime/strike train trips every quarter/hour and its weight descends
    // *while that train runs* (whether or not the sound is audible). The amount
    // is proportional to the work: chime phrases, then the gong count at :00.
    const phrases = quarter === 0 ? 4 : quarter; // 1,2,3,4 phrases
    const chimeDur = ChimeAudio.chimeDuration(settings.chime, quarter);
    scheduleDescent('chime', phrases * UNIT_CHIME, chimeDur);

    let strikeCount = 0;
    if (quarter === 0) {
      strikeCount = (date.getHours() % 12) || 12;
      const strikeDur = strikeCount * settings.strikeGap; // gong spacing (s)
      // The strike train runs after the chime finishes, so its weight descends then.
      setTimeout(() => scheduleDescent('strike', strikeCount * UNIT_STRIKE, strikeDur),
        chimeDur * 1000);
    }

    const silenced = isNightSilenced(date);
    const audible = !silenced && !settings.muted && speed <= AUDIO_SPEED_LIMIT;

    // Visual flash always (even when silenced) so fast-forward shows activity.
    flashDial();

    if (!audible) return;

    ChimeAudio.playChime(settings.chime, quarter);

    if (quarter === 0) {
      // Top of hour: play the phrases, then strike the hour after they finish.
      setTimeout(() => {
        if (!settings.muted) ChimeAudio.playStrike(strikeCount, settings.chime);
      }, chimeDur * 1000);
    }
  }

  /* ===================== UI WIRING ===================== */
  const el = {};
  function cacheUI() {
    el.gearBtn = document.getElementById('gearBtn');
    el.drawer = document.getElementById('drawer');
    el.closeDrawer = document.getElementById('closeDrawer');
    el.themeSeg = document.getElementById('themeSeg');
    el.cloudRange = document.getElementById('cloudRange');
    el.cloudReadout = document.getElementById('cloudReadout');
    el.chimeSeg = document.getElementById('chimeSeg');
    el.speedSeg = document.getElementById('speedSeg');
    el.muteChk = document.getElementById('muteChk');
    el.volRange = document.getElementById('volRange');
    el.nightChk = document.getElementById('nightChk');
    el.tickChk = document.getElementById('tickChk');
    el.tickVolRange = document.getElementById('tickVolRange');
    el.tempoRange = document.getElementById('tempoRange');
    el.tempoReadout = document.getElementById('tempoReadout');
    el.gapRange = document.getElementById('gapRange');
    el.gapReadout = document.getElementById('gapReadout');
    el.strikeGapRange = document.getElementById('strikeGapRange');
    el.strikeGapReadout = document.getElementById('strikeGapReadout');
    el.secondsChk = document.getElementById('secondsChk');
    el.ssRange = document.getElementById('ssRange');
    el.ssReadout = document.getElementById('ssReadout');
    el.testChime = document.getElementById('testChime');
    el.setTime = document.getElementById('setTime');
    el.applyTime = document.getElementById('applyTime');
    el.resetTime = document.getElementById('resetTime');
    el.bigTime = document.getElementById('bigTime');
    el.speedReadout = document.getElementById('speedReadout');
  }

  function setActive(container, attr, value) {
    container.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset[attr] === String(value));
    });
  }

  function applyTheme(theme) {
    settings.theme = theme;
    document.body.dataset.theme = theme;
    setActive(el.themeSeg, 'theme', theme);
    // Reset ambient when leaving auto so light/dark look correct.
    if (theme !== 'auto') {
      document.getElementById('stage').style.removeProperty('--ambient');
    }
    save();
  }

  function applyCloudDensity(pct) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    settings.cloudDensity = pct;
    Clock.setCloudDensity(pct);
    if (el.cloudRange) el.cloudRange.value = pct;
    if (el.cloudReadout) el.cloudReadout.textContent = pct + '%';
    save();
  }

  function applyChime(chime) {
    settings.chime = chime;
    setActive(el.chimeSeg, 'chime', chime);
    save();
  }

  function applyScreensaver(min) {
    min = Math.max(0, Math.min(30, Math.round(Number(min) || 0)));
    settings.screensaverMin = min;
    if (el.ssRange) el.ssRange.value = min;
    if (el.ssReadout) el.ssReadout.textContent = min === 0 ? 'Off' : min + ' min';
    lastActivityAt = Date.now(); // restart the idle countdown with the new value
    save();
  }

  function applyTempo(pct) {
    settings.chimeTempo = pct;
    ChimeAudio.setTempo(pct / 100);
    if (el.tempoRange) el.tempoRange.value = pct;
    if (el.tempoReadout) el.tempoReadout.textContent = pct + '%';
    save();
  }

  function applyPhraseGap(sec) {
    // clamp to the slider's range and one decimal place
    sec = Math.max(0, Math.min(3, Number(sec) || 0));
    settings.phraseGap = sec;
    ChimeAudio.setPhraseGap(sec);
    if (el.gapRange) el.gapRange.value = sec;
    if (el.gapReadout) el.gapReadout.textContent = sec.toFixed(1) + ' s';
    save();
  }

  function applyStrikeGap(sec) {
    sec = Math.max(0.5, Math.min(3, Number(sec) || 1.5));
    settings.strikeGap = sec;
    ChimeAudio.setStrikeGap(sec);
    if (el.strikeGapRange) el.strikeGapRange.value = sec;
    if (el.strikeGapReadout) el.strikeGapReadout.textContent = sec.toFixed(1) + ' s';
    save();
  }

  function applySpeed(speed) {
    settings.speed = speed;
    Clock.setSpeed(speed);
    setActive(el.speedSeg, 'speed', speed);
    save();
  }

  function bind() {
    el.gearBtn.addEventListener('click', () => {
      el.drawer.classList.add('open');
      ChimeAudio.unlock(); // user gesture unlocks audio
    });
    el.closeDrawer.addEventListener('click', () => el.drawer.classList.remove('open'));

    el.themeSeg.addEventListener('click', (e) => {
      if (e.target.dataset.theme) applyTheme(e.target.dataset.theme);
    });
    el.cloudRange.addEventListener('input', () => applyCloudDensity(Number(el.cloudRange.value)));
    el.chimeSeg.addEventListener('click', (e) => {
      if (e.target.dataset.chime) { ChimeAudio.unlock(); applyChime(e.target.dataset.chime); }
    });
    el.speedSeg.addEventListener('click', (e) => {
      if (e.target.dataset.speed) applySpeed(Number(e.target.dataset.speed));
    });

    el.muteChk.addEventListener('change', () => {
      settings.muted = el.muteChk.checked;
      ChimeAudio.setMuted(settings.muted);
      save();
    });
    el.volRange.addEventListener('input', () => {
      settings.volume = Number(el.volRange.value);
      ChimeAudio.setVolume(settings.volume / 100);
      save();
    });
    el.nightChk.addEventListener('change', () => {
      settings.nightSilence = el.nightChk.checked;
      save();
    });
    el.tickChk.addEventListener('change', () => {
      settings.tick = el.tickChk.checked;
      if (settings.tick) ChimeAudio.unlock();
      save();
    });
    el.tickVolRange.addEventListener('input', () => {
      settings.tickVolume = Number(el.tickVolRange.value);
      ChimeAudio.setTickVolume(settings.tickVolume / 100);
      save();
    });
    el.tempoRange.addEventListener('input', () => {
      applyTempo(Number(el.tempoRange.value));
    });
    el.gapRange.addEventListener('input', () => {
      applyPhraseGap(Number(el.gapRange.value));
    });
    el.strikeGapRange.addEventListener('input', () => {
      applyStrikeGap(Number(el.strikeGapRange.value));
    });
    el.secondsChk.addEventListener('change', () => {
      settings.showSeconds = el.secondsChk.checked;
      Clock.showSeconds(settings.showSeconds);
      save();
    });
    el.ssRange.addEventListener('input', () => applyScreensaver(Number(el.ssRange.value)));

    el.testChime.addEventListener('click', () => {
      ChimeAudio.unlock();
      flashDial();
      const testTune = settings.chime === 'silent' ? 'westminster' : settings.chime;
      const dur = ChimeAudio.chimeDuration(testTune, 0);
      const testStrike = 3;
      ChimeAudio.playChime(testTune, 0);
      setTimeout(() => ChimeAudio.playStrike(testStrike, testTune), dur * 1000);
      // Drive the weights just like a real hour chime + strike: the chime
      // weight descends over the chime, then the strike weight over the strike.
      scheduleDescent('chime', 4 * UNIT_CHIME, dur);
      setTimeout(() => scheduleDescent('strike', testStrike * UNIT_STRIKE, testStrike * settings.strikeGap),
        dur * 1000);
    });

    el.applyTime.addEventListener('click', () => {
      const v = el.setTime.value;
      if (!v) return;
      const [hh, mm] = v.split(':').map(Number);
      const d = new Date(Clock.getTime());
      d.setHours(hh, mm, 0, 0);
      Clock.setTime(d.getTime());
      lastQuarterKey = null; // re-arm so the next quarter chimes
    });
    el.resetTime.addEventListener('click', () => {
      Clock.setTime(Date.now());
      lastQuarterKey = null;
    });

    // Winding arbors on the dial — wind the matching weight up only while the
    // key is held down; releasing (or leaving) stops the winding.
    document.querySelectorAll('.winder').forEach((btn) => {
      const which = btn.dataset.arbor;
      const start = (e) => {
        e.preventDefault();
        ChimeAudio.unlock(); // this press is the user gesture that unlocks audio
        // Capture the pointer so a release anywhere still stops winding.
        if (btn.setPointerCapture && e.pointerId != null) {
          try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        }
        windTickAccum = WIND_TICK_MS; // fire the first ratchet tick right away
        setWinding(which, true);
      };
      const stop = () => setWinding(which, false);
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', stop);
      btn.addEventListener('pointerleave', stop); // fallback if no pointer capture
    });
  }

  /* Push loaded settings into the UI controls. */
  function hydrate() {
    applyTheme(settings.theme);
    applyCloudDensity(settings.cloudDensity);
    applyChime(settings.chime);
    applyTempo(settings.chimeTempo);
    applyPhraseGap(settings.phraseGap);
    applyStrikeGap(settings.strikeGap);
    applySpeed(settings.speed);
    el.muteChk.checked = settings.muted;
    el.volRange.value = settings.volume;
    el.nightChk.checked = settings.nightSilence;
    el.tickChk.checked = settings.tick;
    el.tickVolRange.value = settings.tickVolume;
    el.secondsChk.checked = settings.showSeconds;
    applyScreensaver(settings.screensaverMin);

    ChimeAudio.setVolume(settings.volume / 100);
    ChimeAudio.setTickVolume(settings.tickVolume / 100);
    ChimeAudio.setMuted(settings.muted);
    Clock.showSeconds(settings.showSeconds);
  }

  /* ===================== BOOT ===================== */
  document.addEventListener('DOMContentLoaded', () => {
    Clock.init();
    Clock.setOnTick(onTick);
    cacheUI();
    bind();
    hydrate();
    initWeights();

    if (params.has('time')) {
      const [hh, mm] = params.get('time').split(':').map(Number);
      const d = new Date(Clock.getTime());
      d.setHours(hh || 0, mm || 0, 0, 0);
      Clock.setTime(d.getTime());
    }
    if (params.has('moon')) Clock.setMoonPhase(Number(params.get('moon')));

    // Idle detection for the screensaver: any user input counts as activity
    // (and dismisses an active screensaver); a 1s poll triggers it when idle.
    ['mousemove', 'mousedown', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'click', 'scroll']
      .forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    setInterval(checkIdle, 1000);
  });
})();
