/* ===========================================================
   clock.js — dial construction, render loop, hands, moon phase,
   and the auto day/night sky. Exposes a small Clock API used
   by main.js. All visuals derive from a single simulated clock.
   =========================================================== */

const Clock = (() => {
  // --- Simulated time state ---
  let simNow = Date.now();   // ms, the clock's current (possibly accelerated) time
  let speed = 1;             // time multiplier
  let lastFrame = null;

  // --- DOM refs ---
  const el = {};
  // Callback main.js registers to receive each frame's simulated Date.
  let onTick = null;

  const SYNODIC = 29.530588853;        // days, lunar synodic month
  const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14); // known new moon

  function cache() {
    el.hour = document.getElementById('hourHand');
    el.minute = document.getElementById('minuteHand');
    el.second = document.getElementById('secondHand');
    el.numerals = document.getElementById('numerals');
    el.ticks = document.getElementById('ticks');
    el.subSeconds = document.getElementById('subSeconds');
    el.subTicks = document.getElementById('subTicks');
    el.dateText = document.getElementById('dateText');
    el.moonDisc = document.getElementById('moonDisc');
    el.sky = document.getElementById('sky');
    el.stars = document.getElementById('stars');
    el.clouds = document.getElementById('clouds');
    el.overcast = document.getElementById('overcast');
    el.mountains = document.getElementById('mountains');
    el.screensaver = document.getElementById('screensaver');
    el.stage = document.getElementById('stage');
  }

  /* ---------- Build the dial (numerals + ticks) once ---------- */
  function buildDial() {
    const ROMAN = ['XII','I','II','III','IV','V','VI','VII','VIII','IX','X','XI'];
    const radius = 200; // px from center for numeral placement
    for (let i = 0; i < 12; i++) {
      const ang = (i * 30) * Math.PI / 180;
      const x = Math.sin(ang) * radius;
      const y = -Math.cos(ang) * radius;
      const span = document.createElement('span');
      span.className = 'numeral';
      span.textContent = ROMAN[i];
      span.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
      el.numerals.appendChild(span);
    }
    for (let i = 0; i < 60; i++) {
      const tick = document.createElement('div');
      tick.className = 'tick' + (i % 5 === 0 ? ' major' : '');
      // place at top, rotate around center, push outward
      tick.style.transform = `rotate(${i * 6}deg) translateY(-236px)`;
      el.ticks.appendChild(tick);
    }
    // Seconds subdial: all 60 second marks, majors every 5 seconds.
    for (let i = 0; i < 60; i++) {
      const t = document.createElement('div');
      t.className = 'sub-tick' + (i % 5 === 0 ? ' major' : '');
      t.style.transform = `rotate(${i * 6}deg) translateY(-46px)`;
      el.subTicks.appendChild(t);
    }
  }

  /* ---------- Clouds (density-driven) ---------- */
  // Up to MAX_CLOUDS at 100% density. The first four specs reproduce the
  // original hand-placed clouds, so 20% density == the previous look.
  // 100% packs the sky with MAX_CLOUDS (mostly overcast); the count curve is
  // shaped so 20% still yields exactly 4 clouds (the original look).
  const MAX_CLOUDS = 50;
  const CLOUD_EXP = Math.log(4 / MAX_CLOUDS) / Math.log(0.2); // count(20%) == 4
  const CLOUD_SPECS = (() => {
    const specs = [
      { top: 12, w: 240, h: 84,  op: 0.92 },
      { top: 25, w: 180, h: 64,  op: 0.80 },
      { top: 6,  w: 320, h: 108, op: 0.85 },
      { top: 32, w: 150, h: 56,  op: 0.72 },
    ];
    // Fill the rest with deterministic variety (stable across rebuilds). The
    // higher-index clouds run bigger and span more of the sky's height so a
    // full deck reads as overcast rather than scattered puffs.
    for (let i = 4; i < MAX_CLOUDS; i++) {
      const w = 200 + (i * 53) % 190;        // 200..389
      specs.push({
        top: (i * 37) % 66,                  // 0..65% — lowest clouds reach just below the peaks
        w, h: Math.round(w * 0.36),
        op: 0.66 + ((i * 17) % 30) / 100,    // 0.66..0.95
      });
    }
    return specs;
  })();

  const CLOUD_PERIOD = 90;    // seconds for one cloud to drift across the sky
  const CLOUD_MARGIN = 360;   // px off-screen at each wrap (>= widest cloud)
  let cloudObjs = [];         // { el, x } for each live cloud, moved each frame
  let cloudDensity = 20;      // current density %, used for the overcast haze

  // How opaque the overcast sheet is for a given density (0 until ~30%, rising
  // to a near-solid deck at 100% so it reads as mostly overcast).
  function overcastLevel(d) { return Math.max(0, (d - 30) / 70) * 0.88; }

  function buildClouds(pct) {
    if (!el.clouds) return;
    const d = Math.max(0, Math.min(100, Number(pct) || 0));
    cloudDensity = d;
    const count = d <= 0 ? 0 : Math.round(Math.pow(d / 100, CLOUD_EXP) * MAX_CLOUDS);
    const vw = window.innerWidth || 1080;
    const span = vw + CLOUD_MARGIN;     // wrap distance (entry-to-entry)
    el.clouds.innerHTML = '';
    cloudObjs = [];
    for (let i = 0; i < count; i++) {
      const s = CLOUD_SPECS[i];
      const c = document.createElement('div');
      c.className = 'cloud';
      c.style.top = s.top + '%';
      c.style.width = s.w + 'px';
      c.style.height = s.h + 'px';
      c.style.opacity = s.op;
      // Phase the clouds evenly across one cycle so they're always spaced a
      // constant time apart — at higher density they enter the left sooner
      // (interval = CLOUD_PERIOD / count).
      const x = (i / Math.max(1, count)) * span - CLOUD_MARGIN;
      c.style.transform = `translateX(${x}px)`;
      el.clouds.appendChild(c);
      cloudObjs.push({ el: c, x });
    }
  }

  /* Drift a set of clouds left->right in real time; the instant a cloud clears
     the right edge it wraps back just off the left, so it respawns promptly. */
  function driftCloudArray(arr, dtMs) {
    if (!arr.length) return;
    const vw = window.innerWidth || 1080;
    const span = vw + CLOUD_MARGIN;
    const dx = (span / CLOUD_PERIOD) * (dtMs / 1000);
    for (const c of arr) {
      c.x += dx;
      if (c.x > vw) c.x -= span;   // fully past the right edge -> back to the left
      c.el.style.transform = `translateX(${c.x}px)`;
    }
  }
  function moveClouds(dtMs) { driftCloudArray(cloudObjs, dtMs); }

  /* ---------- Screensaver clouds (over everything, all levels) ---------- */
  let ssCloudObjs = [];
  let screensaverOn = false;
  const SS_COUNT = 30; // generous cover across the full viewport

  function buildScreensaverClouds() {
    if (!el.screensaver) return;
    const vw = window.innerWidth || 1080;
    const span = vw + CLOUD_MARGIN;
    el.screensaver.innerHTML = '';
    ssCloudObjs = [];
    for (let i = 0; i < SS_COUNT; i++) {
      const w = 220 + (i * 53) % 260;          // 220..479
      const c = document.createElement('div');
      c.className = 'cloud';
      c.style.top = ((i * 37) % 92) + '%';     // spawn at ALL levels of the viewport
      c.style.width = w + 'px';
      c.style.height = Math.round(w * 0.36) + 'px';
      c.style.opacity = (0.82 + ((i * 13) % 18) / 100).toFixed(2);
      const x = (i / SS_COUNT) * span - CLOUD_MARGIN;  // evenly phased for steady cover
      c.style.transform = `translateX(${x}px)`;
      el.screensaver.appendChild(c);
      ssCloudObjs.push({ el: c, x });
    }
  }

  /* Show/hide the screensaver cloud layer. */
  function setScreensaver(on) {
    if (!el.screensaver || on === screensaverOn) return;
    screensaverOn = on;
    if (on) {
      buildScreensaverClouds();
      el.screensaver.classList.add('on');
    } else {
      el.screensaver.classList.remove('on');
      // keep drifting through the fade-out, then remove the cloud nodes
      setTimeout(() => {
        if (!screensaverOn) { ssCloudObjs = []; if (el.screensaver) el.screensaver.innerHTML = ''; }
      }, 1100);
    }
  }

  /* ---------- Moon phase ---------- */
  let moonOverride = null;  // testing: pin the phase (0..1) via Clock.setMoonPhase
  function updateMoon(date) {
    let phase;
    if (moonOverride != null) {
      phase = moonOverride;
    } else {
      const days = (date.getTime() - NEW_MOON_EPOCH) / 86400000;
      phase = (days % SYNODIC) / SYNODIC;  // 0..1 (0 = new, 0.5 = full)
      if (phase < 0) phase += 1;
    }

    // The moon transits the arch between the two earth globes. Position alone
    // encodes the phase, exactly like a real lunar dial: the globes occlude it
    // at the horizons (crescents) and it's fully clear at the top (full moon).
    // It moves left while waxing and right while waning (so the visible side is
    // lit correctly: waxing crescent on the left shows its right edge).
    //   phase 0   (new)  -> hidden behind the LEFT globe, near the horizon
    //   phase 0.5 (full) -> centered at the top of the arch
    //   phase 1   (new)  -> hidden behind the RIGHT globe, near the horizon
    const ARCH_W = 360 - 16;  // inner width (minus the 8px brass border each side)
    const ARCH_H = 190 - 8;
    const MOON = 66;
    const cx = 30 + phase * (ARCH_W - 60);   // moon centre x (0 -> left, 1 -> right)
    const arc = Math.sin(phase * Math.PI);   // 0 at horizons, 1 at top-centre
    const cy = ARCH_H - 28 - arc * (ARCH_H - 90); // moon centre y (from top)
    el.moonDisc.style.left = `${cx - MOON / 2}px`;
    el.moonDisc.style.top = `${cy - MOON / 2}px`;
  }

  /* ---------- Auto day/night sky ---------- */
  // Returns {sky: cssGradient, ambient: number} for a given hour (0..24 float).
  function skyForHour(h) {
    // Keyframes of sky colors through the day.
    const stops = [
      { h: 0,  top: '#05070f', bot: '#0a1024', amb: 0.55 }, // midnight
      { h: 5,  top: '#0a1430', bot: '#1c2350', amb: 0.6 },  // pre-dawn
      { h: 6.5,top: '#27365f', bot: '#c8783f', amb: 0.78 }, // dawn
      { h: 8,  top: '#5b86c4', bot: '#bcd3ef', amb: 0.95 }, // morning
      { h: 12, top: '#5fa0e6', bot: '#d8ecff', amb: 1.05 }, // noon
      { h: 17, top: '#5b86c4', bot: '#cfe0f4', amb: 0.98 }, // afternoon
      { h: 18.5,top:'#384a86', bot: '#e08a4a', amb: 0.8 },  // sunset
      { h: 20, top: '#1b2350', bot: '#3a2d57', amb: 0.66 }, // dusk
      { h: 22, top: '#0a1024', bot: '#141a3a', amb: 0.58 }, // night
      { h: 24, top: '#05070f', bot: '#0a1024', amb: 0.55 }, // midnight
    ];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (h >= stops[i].h && h <= stops[i + 1].h) { a = stops[i]; b = stops[i + 1]; break; }
    }
    const t = (h - a.h) / (b.h - a.h || 1);
    const top = lerpColor(a.top, b.top, t);
    const bot = lerpColor(a.bot, b.bot, t);
    const amb = a.amb + (b.amb - a.amb) * t;
    return { sky: `linear-gradient(180deg, ${top} 0%, ${bot} 100%)`, ambient: amb };
  }

  function lerpColor(c1, c2, t) {
    const a = hexToRgb(c1), b = hexToRgb(c2);
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    return `rgb(${r},${g},${bl})`;
  }
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function applyAutoTheme(date) {
    const h = date.getHours() + date.getMinutes() / 60;
    const { sky, ambient } = skyForHour(h);
    el.sky.style.background = sky;
    el.stage.style.setProperty('--ambient', ambient.toFixed(3));
    // Stars fade in as the sky darkens: full at deep night (ambient ~0.6),
    // gone once it's bright enough (ambient ~0.85).
    const stars = Math.max(0, Math.min(1, (0.85 - ambient) / (0.85 - 0.6)));
    el.stars.style.opacity = stars.toFixed(3);
    // Clouds (and the overcast haze) fade in with daylight (opposite of the
    // stars) and the mountains dim toward night so the scene tracks the time.
    const dayFactor = Math.max(0, Math.min(1, (ambient - 0.6) / (1.05 - 0.6)));
    if (el.clouds) el.clouds.style.opacity = (dayFactor * 0.92).toFixed(3);
    if (el.overcast) el.overcast.style.opacity = (dayFactor * overcastLevel(cloudDensity)).toFixed(3);
    if (el.mountains) {
      el.mountains.style.filter = `brightness(${Math.max(0.5, Math.min(1, ambient)).toFixed(3)})`;
    }
  }

  /* ---------- Hands ---------- */
  function updateHands(date) {
    const s = date.getSeconds() + date.getMilliseconds() / 1000;
    const m = date.getMinutes() + s / 60;
    const h = (date.getHours() % 12) + m / 60;
    el.hour.style.transform = `rotate(${h * 30}deg)`;
    el.minute.style.transform = `rotate(${m * 6}deg)`;
    // Second hand ticks: snap to whole seconds rather than sweeping smoothly.
    el.second.style.transform = `rotate(${Math.floor(s) * 6}deg)`;
  }

  function updateDate(date) {
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    el.dateText.textContent = date.toLocaleDateString(undefined, opts);
  }

  /* ---------- Main render loop ---------- */
  function frame(ts) {
    if (lastFrame == null) lastFrame = ts;
    const dt = ts - lastFrame;
    lastFrame = ts;

    simNow += dt * speed;
    const date = new Date(simNow);

    updateHands(date);
    updateDate(date);
    updateMoon(date);
    if (document.body.dataset.theme === 'auto') { applyAutoTheme(date); moveClouds(dt); }
    if (ssCloudObjs.length) driftCloudArray(ssCloudObjs, dt); // screensaver (any theme)

    // Pass both simulated and real elapsed ms so consumers can advance
    // time-based state (weights) and real-time animations (winding).
    if (onTick) onTick(date, speed, dt * speed, dt);
    requestAnimationFrame(frame);
  }

  /* ---------- Viewport scaling to fit 1080x1920 ---------- */
  function fit() {
    const scale = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
    el.stage.style.transform = `scale(${scale})`;
  }

  /* ---------- Public API ---------- */
  function init() {
    cache();
    buildDial();
    buildClouds(20); // default; main.js overrides from saved settings
    fit();
    window.addEventListener('resize', fit);
    requestAnimationFrame(frame);
  }
  function setSpeed(v) { speed = v; }
  function getSpeed() { return speed; }
  function setTime(ms) { simNow = ms; }
  function getTime() { return simNow; }
  function setMoonPhase(p) { moonOverride = (p == null ? null : ((p % 1) + 1) % 1); }
  function setOnTick(fn) { onTick = fn; }
  function showSeconds(show) { el.subSeconds.style.display = show ? '' : 'none'; }
  function setCloudDensity(pct) { buildClouds(pct); }

  return { init, setSpeed, getSpeed, setTime, getTime, setMoonPhase, setOnTick, showSeconds, setCloudDensity, setScreensaver };
})();
