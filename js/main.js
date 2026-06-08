/* ===========================================================
   main.js — settings, chime scheduling, night silence, theme,
   persistence. Ties the UI drawer to Clock + ChimeAudio.
   =========================================================== */

(() => {
  const STORE_KEY = 'gfclock.settings';

  const defaults = {
    theme: 'light',
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
    speed: 1,
  };

  const settings = Object.assign({}, defaults, load());

  // URL query overrides (handy for deep-linked testing, e.g. ?theme=auto&speed=3600&time=11:59)
  const params = new URLSearchParams(location.search);
  if (params.has('theme')) settings.theme = params.get('theme');
  if (params.has('chime')) settings.chime = params.get('chime');
  if (params.has('speed')) settings.speed = Number(params.get('speed')) || settings.speed;
  if (params.has('tempo')) settings.chimeTempo = Number(params.get('tempo')) || settings.chimeTempo;
  if (params.has('gap')) settings.phraseGap = Number(params.get('gap'));
  if (params.has('strikegap')) settings.strikeGap = Number(params.get('strikegap'));

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  }

  // ---- Chime scheduling state ----
  // Track the last quarter index we chimed so we fire exactly once per quarter.
  let lastQuarterKey = null;
  let lastTickSec = null; // absolute floored second, for the per-second tick sound
  const AUDIO_SPEED_LIMIT = 4; // above this, suppress audio (visual flash only)

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

  /* Called every frame by the clock with the current simulated Date. */
  function onTick(date, speed) {
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

    const silenced = isNightSilenced(date);
    const audible = !silenced && !settings.muted && speed <= AUDIO_SPEED_LIMIT;

    // Visual flash always (even when silenced) so fast-forward shows activity.
    flashDial();

    if (!audible) return;

    // quarter index used by the audio tables: 1=:15, 2=:30, 3=:45, 0=:00
    const qKey = quarter; // 0 at top of hour
    ChimeAudio.playChime(settings.chime, qKey);

    if (quarter === 0) {
      // Top of hour: play the 4 phrases, then strike the hour after they finish.
      const dur = ChimeAudio.chimeDuration(settings.chime, 0);
      const count = ((date.getHours() % 12) || 12);
      setTimeout(() => {
        if (!settings.muted) ChimeAudio.playStrike(count, settings.chime);
      }, dur * 1000);
    }
  }

  /* ===================== UI WIRING ===================== */
  const el = {};
  function cacheUI() {
    el.gearBtn = document.getElementById('gearBtn');
    el.drawer = document.getElementById('drawer');
    el.closeDrawer = document.getElementById('closeDrawer');
    el.themeSeg = document.getElementById('themeSeg');
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

  function applyChime(chime) {
    settings.chime = chime;
    setActive(el.chimeSeg, 'chime', chime);
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

    el.testChime.addEventListener('click', () => {
      ChimeAudio.unlock();
      flashDial();
      const testTune = settings.chime === 'silent' ? 'westminster' : settings.chime;
      ChimeAudio.playChime(testTune, 0);
      const dur = ChimeAudio.chimeDuration(testTune, 0);
      setTimeout(() => ChimeAudio.playStrike(3, testTune), dur * 1000);
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
  }

  /* Push loaded settings into the UI controls. */
  function hydrate() {
    applyTheme(settings.theme);
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

    if (params.has('time')) {
      const [hh, mm] = params.get('time').split(':').map(Number);
      const d = new Date(Clock.getTime());
      d.setHours(hh || 0, mm || 0, 0, 0);
      Clock.setTime(d.getTime());
    }
    if (params.has('moon')) Clock.setMoonPhase(Number(params.get('moon')));
  });
})();
