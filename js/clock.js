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
    // Seconds subdial: 12 marks (every 5 seconds), majors at the quarters.
    for (let i = 0; i < 12; i++) {
      const t = document.createElement('div');
      t.className = 'sub-tick' + (i % 3 === 0 ? ' major' : '');
      t.style.transform = `rotate(${i * 30}deg) translateY(-46px)`;
      el.subTicks.appendChild(t);
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
    if (document.body.dataset.theme === 'auto') applyAutoTheme(date);

    if (onTick) onTick(date, speed);
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

  return { init, setSpeed, getSpeed, setTime, getTime, setMoonPhase, setOnTick, showSeconds };
})();
