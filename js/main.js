/* ===========================================================
   main.js — settings, chime scheduling, night silence, theme,
   persistence. Ties the UI drawer to Clock + ChimeAudio.
   =========================================================== */

(() => {
  const STORE_KEY = 'gfclock.settings';

  const defaults = {
    theme: 'auto',
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
    screensaverMin: 5,    // idle minutes before the cloud screensaver (0 = off)
    screensaverClouds: 40, // max simultaneous screensaver clouds
    screensaverFirefly: true, // show the purple firefly over the screensaver clouds
    shootingCount: 1,    // meteors per burst in the night sky (0 = off)
    shootingFreq: 9,     // average seconds between shooting-star bursts
    satellites: true,    // slow satellites crossing the night sky
    satelliteFreq: 45,   // average seconds between satellites
    autoWind: false,     // auto-wind a weight back to the top when it bottoms out
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
  if (params.has('ssclouds')) settings.screensaverClouds = Number(params.get('ssclouds'));
  if (params.has('ssfirefly')) settings.screensaverFirefly = params.get('ssfirefly') !== '0';
  if (params.has('shootcount')) settings.shootingCount = Number(params.get('shootcount'));
  if (params.has('shootfreq')) settings.shootingFreq = Number(params.get('shootfreq'));
  if (params.has('autowind')) settings.autoWind = params.get('autowind') !== '0';
  if (params.has('satellites')) settings.satellites = params.get('satellites') !== '0';
  if (params.has('satfreq')) settings.satelliteFreq = Number(params.get('satfreq'));

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

  // ---- Going train / pendulum ----
  // The pendulum is the escapement: the clock keeps time only while it's swinging.
  // The time weight merely provides the *drive* that sustains the swing. So a
  // wound weight does NOT restart a stopped clock — you must push the pendulum
  // (drag it aside and release). `swingDeg` is the current swing amplitude in
  // degrees; the clock's rate tracks it (relative to the natural amplitude) so
  // the clock coasts down and back up smoothly.
  const SWING_DEG = 7;               // natural full-amplitude swing angle (matches the CSS keyframe)
  const going = { running: true, swingDeg: SWING_DEG, dragging: false, dragDeg: 0, beatSide: 0 };
  const RUNDOWN_MS = 120000;         // swing 7°->0 while running with no drive (~2 min coast to stop)
  const EASE_MS = 6000;              // time constant easing the swing toward its natural amplitude
  const SETTLE_MS = 1400;            // swing ->0 once stopped (pendulum settles to rest)
  const PUSH_START_DEG = 2.5;        // release beyond this angle starts it; within it stops it
  const BEAT_DEG = 4;                // hand-swinging past this (alternating sides) beats the escapement once
  const DRAG_MAX_DEG = 18;           // clamp how far the pendulum can be dragged aside
  let pendPivot = null;              // {x,y} screen coords of the pendulum's pivot, set on grab
  const beatSideOf = (deg) => (deg >= BEAT_DEG ? 1 : (deg <= -BEAT_DEG ? -1 : 0));
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

  /* Advance the escapement each frame. The pendulum sustains its swing only
     while it's running AND the time weight still has drive (drop < 1):
       - running + drive   -> amplitude builds to full, clock keeps time
       - running + no drive -> amplitude coasts to zero over ~2 min, then stops
       - not running        -> amplitude settles to zero (clock stopped)
     The amplitude doubles as the clock's rate, so timekeeping (hands, seconds)
     speeds up and winds down with the swing. While the pendulum is being
     dragged, the escapement is disengaged and the clock is paused. */
  function updateGoing(dtReal) {
    if (going.dragging) { Clock.setTimePower(0); return; } // held by the user
    const hasDrive = weight.time.drop < 1;
    if (going.running) {
      if (hasDrive) {
        // Ease the swing toward its natural amplitude — gliding down from a big
        // pull, or up from a small nudge — rather than snapping to it.
        going.swingDeg += (SWING_DEG - going.swingDeg) * (1 - Math.exp(-dtReal / EASE_MS));
      } else {
        // No drive (weight bottomed): the swing coasts down to a stop over ~2 min.
        going.swingDeg = Math.max(0, going.swingDeg - SWING_DEG * dtReal / RUNDOWN_MS);
        if (going.swingDeg <= 0.1) { going.swingDeg = 0; going.running = false; }
      }
    } else {
      // Stopped: the pendulum settles to rest (clock already halted below).
      going.swingDeg = Math.max(0, going.swingDeg - SWING_DEG * dtReal / SETTLE_MS);
    }
    // The escapement keeps time only while running; the rate tracks the swing
    // (capped at full) so the clock slows as it coasts down.
    Clock.setTimePower(going.running ? Math.min(1, going.swingDeg / SWING_DEG) : 0);
    if (el.pendulum) {
      el.pendulum.style.setProperty('--swing', going.swingDeg.toFixed(2) + 'deg');
    }
  }

  /* ---- Dragging the pendulum: push it to start, bring it to rest to stop ---- */
  function pendDragAngle(e) {
    const dx = e.clientX - pendPivot.x;
    const dy = Math.max(1, e.clientY - pendPivot.y);   // pivot is above the bob
    const deg = Math.atan2(dx, dy) * 180 / Math.PI;     // 0 = hanging straight down
    return Math.max(-DRAG_MAX_DEG, Math.min(DRAG_MAX_DEG, deg));
  }
  function pendDragMove(e) {
    if (!going.dragging) return;
    going.dragDeg = pendDragAngle(e);   // bob angle from vertical, + = right
    // The pivot is above the bob, so a positive CSS rotation swings the bob
    // LEFT — negate so the bob follows the cursor.
    el.pendulum.style.transform = `rotate(${(-going.dragDeg).toFixed(2)}deg)`;
    // Hand-beating the escapement: each swing past the beat angle, alternating
    // sides, advances the clock one second — just as the real escapement steps
    // once per swing of a seconds pendulum.
    const side = beatSideOf(going.dragDeg);
    if (side !== 0 && side !== going.beatSide) {
      going.beatSide = side;
      Clock.setTime(Clock.getTime() + 1000);  // onTick then ticks the second + any chime
    }
  }
  function pendDragEnd() {
    if (!going.dragging) return;
    going.dragging = false;
    window.removeEventListener('pointermove', pendDragMove);
    el.pendulum.style.transform = '';     // hand control back to the swing animation
    const phi = going.dragDeg;            // + = released to the right
    going.swingDeg = Math.abs(phi);       // begin swinging at exactly the released amplitude
    going.running = Math.abs(phi) >= PUSH_START_DEG; // enough = start; near the bottom = stop
    if (!going.running) Clock.setTimePower(0);
    // Start the swing from the released side. In the keyframe, 0% is the bob's
    // LEFT extreme (rotate +--swing) and 50% its RIGHT extreme; so begin half a
    // cycle in (negative delay) when released to the right, else it snaps across.
    el.pendulum.style.setProperty('--swing', going.swingDeg.toFixed(2) + 'deg');
    el.pendulum.style.animation = 'none';
    void el.pendulum.offsetWidth;         // reflow so the animation restarts cleanly
    el.pendulum.style.animation = `swing 2s ease-in-out ${phi > 0 ? '-1s' : '0s'} infinite`;
  }
  function pendDragStart(e) {
    e.preventDefault();
    going.dragging = true;
    // Measure the pivot (transform-origin: top centre) with the element upright.
    el.pendulum.style.animation = 'none';
    el.pendulum.style.transform = 'rotate(0deg)';
    const r = el.pendulum.getBoundingClientRect();
    pendPivot = { x: r.left + r.width / 2, y: r.top };
    going.beatSide = beatSideOf(pendDragAngle(e));  // grabbing aside shouldn't beat
    pendDragMove(e);
    window.addEventListener('pointermove', pendDragMove);
    window.addEventListener('pointerup', pendDragEnd, { once: true });
    window.addEventListener('pointercancel', pendDragEnd, { once: true });
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
    // Auto-wind: a weight that has run all the way down winds itself back up.
    if (settings.autoWind) {
      for (const k in weight) {
        if (weight[k].drop >= 1 && !weight[k].winding) weight[k].winding = true;
      }
    }
    // Advance the pendulum/escapement (sets the clock's rate + swing amplitude).
    updateGoing(dtReal);
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

  /* Jump the clock to an absolute time (ms). Setting the time also gets the
     going train running again: restore full power and, if the time weight had
     run all the way down (which freezes the clock), wind it back to the top —
     otherwise the clock would just sit frozen at the new time. */
  function jumpTo(ms) {
    if (weight.time.drop >= 1) weight.time.drop = 0; // give it drive
    going.running = true;                            // set the escapement going
    going.swingDeg = SWING_DEG;
    Clock.setTimePower(1);
    Clock.setTime(ms);
    lastQuarterKey = null; // re-arm so the next quarter chimes
    lastTickSec = null;    // re-arm the per-second tick at the new time
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

    // A train only works while its weight still has drop left; once it bottoms
    // out (and isn't auto-wound) it goes dead — no sound, no further descent.
    const chimeOk = weight.chime.drop < 1;
    const strikeOk = weight.strike.drop < 1;
    const willStrike = quarter === 0 && strikeOk;

    // The chime/strike train trips every quarter/hour and its weight descends
    // *while that train runs* (whether or not the sound is audible). The amount
    // is proportional to the work: chime phrases, then the gong count at :00.
    const phrases = quarter === 0 ? 4 : quarter; // 1,2,3,4 phrases
    const chimeDur = ChimeAudio.chimeDuration(settings.chime, quarter);
    if (chimeOk) scheduleDescent('chime', phrases * UNIT_CHIME, chimeDur);

    let strikeCount = 0;
    if (willStrike) {
      strikeCount = (date.getHours() % 12) || 12;
      const strikeDur = strikeCount * settings.strikeGap; // gong spacing (s)
      // The strike train runs after the chime finishes, so its weight descends then.
      setTimeout(() => scheduleDescent('strike', strikeCount * UNIT_STRIKE, strikeDur),
        chimeDur * 1000);
    }

    const silenced = isNightSilenced(date);
    const audible = !silenced && !settings.muted && speed <= AUDIO_SPEED_LIMIT;

    // Visual flash when a train actually runs (even when silenced) so
    // fast-forward shows activity — but not when both trains are dead.
    if (chimeOk || willStrike) flashDial();

    if (!audible) return;

    if (chimeOk) ChimeAudio.playChime(settings.chime, quarter);

    if (willStrike) {
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
    el.pendulum = document.getElementById('pendulum');
    el.autoWindChk = document.getElementById('autoWindChk');
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
    el.ssCloudRange = document.getElementById('ssCloudRange');
    el.ssCloudReadout = document.getElementById('ssCloudReadout');
    el.ssFireflyChk = document.getElementById('ssFireflyChk');
    el.shootCountRange = document.getElementById('shootCountRange');
    el.shootCountReadout = document.getElementById('shootCountReadout');
    el.shootFreqRange = document.getElementById('shootFreqRange');
    el.shootFreqReadout = document.getElementById('shootFreqReadout');
    el.satChk = document.getElementById('satChk');
    el.satFreqRange = document.getElementById('satFreqRange');
    el.satFreqReadout = document.getElementById('satFreqReadout');
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

  function applyScreensaverClouds(n) {
    n = Math.max(5, Math.min(50, Math.round(Number(n) || 40)));
    settings.screensaverClouds = n;
    Clock.setScreensaverClouds(n);
    if (el.ssCloudRange) el.ssCloudRange.value = n;
    if (el.ssCloudReadout) el.ssCloudReadout.textContent = String(n);
    save();
  }

  function applyScreensaverFirefly(on) {
    settings.screensaverFirefly = !!on;
    Clock.setFirefly(settings.screensaverFirefly);
    if (el.ssFireflyChk) el.ssFireflyChk.checked = settings.screensaverFirefly;
    save();
  }

  function applyShootingStars() {
    const count = Math.max(0, Math.min(5, Math.round(Number(settings.shootingCount) || 0)));
    const freq = Math.max(2, Math.min(60, Math.round(Number(settings.shootingFreq) || 9)));
    settings.shootingCount = count;
    settings.shootingFreq = freq;
    Clock.setShootingStars(freq, count);
    if (el.shootCountRange) el.shootCountRange.value = count;
    if (el.shootCountReadout) el.shootCountReadout.textContent = count === 0 ? 'Off' : String(count);
    if (el.shootFreqRange) el.shootFreqRange.value = freq;
    if (el.shootFreqReadout) el.shootFreqReadout.textContent = freq + ' s';
    save();
  }

  function applySatellites() {
    const on = !!settings.satellites;
    const freq = Math.max(5, Math.min(180, Math.round(Number(settings.satelliteFreq) || 45)));
    settings.satellites = on;
    settings.satelliteFreq = freq;
    Clock.setSatellites(on, freq);
    if (el.satChk) el.satChk.checked = on;
    if (el.satFreqRange) el.satFreqRange.value = freq;
    if (el.satFreqReadout) el.satFreqReadout.textContent = freq + ' s';
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
    // Click anywhere outside the open drawer (and not on the gear) closes it.
    document.addEventListener('click', (e) => {
      if (!el.drawer.classList.contains('open')) return;
      if (el.drawer.contains(e.target) || el.gearBtn.contains(e.target)) return;
      el.drawer.classList.remove('open');
    });

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
    el.autoWindChk.addEventListener('change', () => {
      settings.autoWind = el.autoWindChk.checked;
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
    el.ssCloudRange.addEventListener('input', () => applyScreensaverClouds(Number(el.ssCloudRange.value)));
    el.ssFireflyChk.addEventListener('change', () => applyScreensaverFirefly(el.ssFireflyChk.checked));
    el.shootCountRange.addEventListener('input', () => { settings.shootingCount = Number(el.shootCountRange.value); applyShootingStars(); });
    el.shootFreqRange.addEventListener('input', () => { settings.shootingFreq = Number(el.shootFreqRange.value); applyShootingStars(); });
    el.satChk.addEventListener('change', () => { settings.satellites = el.satChk.checked; applySatellites(); });
    el.satFreqRange.addEventListener('input', () => { settings.satelliteFreq = Number(el.satFreqRange.value); applySatellites(); });

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
      const v = el.setTime.value;        // "HH:MM" or, with step=1, "HH:MM:SS"
      if (!v) return;
      const [hh, mm, ss] = v.split(':').map(Number);
      if (Number.isNaN(hh) || Number.isNaN(mm)) return;  // guard against an invalid date
      const d = new Date(Clock.getTime());
      d.setHours(hh, mm, ss || 0, 0);     // include seconds when present
      jumpTo(d.getTime());
    });
    el.resetTime.addEventListener('click', () => jumpTo(Date.now()));

    // Grab the pendulum to push-start it (drag aside + release) or stop it
    // (bring it to rest near the bottom of the arc).
    if (el.pendulum) el.pendulum.addEventListener('pointerdown', pendDragStart);

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
    el.autoWindChk.checked = settings.autoWind;
    el.tickChk.checked = settings.tick;
    el.tickVolRange.value = settings.tickVolume;
    el.secondsChk.checked = settings.showSeconds;
    applyScreensaver(settings.screensaverMin);
    applyScreensaverClouds(settings.screensaverClouds);
    applyScreensaverFirefly(settings.screensaverFirefly);
    applyShootingStars();
    applySatellites();

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
      const [hh, mm, ss] = params.get('time').split(':').map(Number);
      const d = new Date(Clock.getTime());
      d.setHours(hh || 0, mm || 0, ss || 0, 0);
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
