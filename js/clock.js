/* ===========================================================
   clock.js — dial construction, render loop, hands, moon phase,
   and the auto day/night sky. Exposes a small Clock API used
   by main.js. All visuals derive from a single simulated clock.
   =========================================================== */

const Clock = (() => {
  // --- Simulated time state ---
  let simNow = Date.now();   // ms, the clock's current (possibly accelerated) time
  let speed = 1;             // time multiplier
  let timePower = 1;         // going-train power 0..1 (drops as the time weight runs out)
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
    // Enlarge the deck: the biggest clouds grow +75% while the smallest keep
    // their current size (a linear remap of width anchored at the smallest;
    // height scales with width so proportions hold).
    const ws = specs.map((s) => s.w);
    const minW = Math.min(...ws), maxW = Math.max(...ws);
    const f = (maxW * 1.75 - minW) / (maxW - minW);
    for (const s of specs) {
      const nw = Math.round(minW + (s.w - minW) * f);
      s.h = Math.round(s.h * nw / s.w);
      s.w = nw;
    }
    return specs;
  })();

  /* Build a unique cloud shape from a cluster of soft white "puff" lobes. Every
     cloud gets its own random set, so there's an unlimited variety of forms and
     the goo filter merges the lobes into one smooth, all-curves blob. There is no
     flat base — the bottom is as bumpy as the top, made of the same round puffs.
     Each lobe is kept fully inside the element box: a background only paints
     inside its box, so a lobe spilling past an edge would be sliced into a
     straight line — clamping guarantees the whole outline stays curved.
     Returns a CSS `background` value of stacked radial-gradients. */
  function randomCloudBackground() {
    const FADE = 0.82;   // a lobe's white reaches ~82% of its gradient radius
    const rand = (a, b) => a + Math.random() * (b - a);
    // Keep v inside [lo,hi]; if the lobe is too big to fit (hi<lo), sit it centred.
    const clamp = (v, lo, hi) => (hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
    const lobes = [];

    // Add one round-ish puff, biased into the given x/size/y ranges, then clamped
    // so its painted area never touches the box edge (no straight cuts).
    function puff(xLo, xHi, hMin, hMax, yLo, yHi) {
      const h = rand(hMin, hMax);                  // vertical radius (% of box height)
      const w = h * rand(0.30, 0.46);              // horizontal radius — round-ish on screen
      const sv = h * FADE, sh = w * FADE;          // painted half-extents
      const y = clamp(rand(yLo, yHi), sv + 2, 98 - sv);
      const x = clamp(rand(xLo, xHi), sh + 2, 98 - sh);
      const c = 70 + Math.floor(Math.random() * 4);
      lobes.push(`radial-gradient(${Math.round(w)}% ${Math.round(h)}% at ${Math.round(x)}% ${Math.round(y)}%, #fff 0 ${c}%, transparent ${c + 2}%)`);
    }

    // A core row of big puffs spanning left→right keeps the cloud connected.
    const core = 3 + Math.floor(Math.random() * 2);          // 3–4
    for (let i = 0; i < core; i++) {
      const f = (i + 0.5) / core;
      puff(f * 70 + 15 - 8, f * 70 + 15 + 8, 40, 56, 46, 60);
    }
    // Smaller bumps scattered all around — including low down — give the irregular,
    // curvy outline and the bumpy bottom (in place of the old flat base).
    const bumps = 4 + Math.floor(Math.random() * 4);         // 4–7
    for (let i = 0; i < bumps; i++) puff(15, 85, 22, 40, 35, 82);

    return lobes.join(', ');
  }

  // Cache sky-cloud shapes by index so the same cloud keeps its form across
  // rebuilds (e.g. when the density slider re-runs buildClouds).
  const skyCloudBgs = [];

  const CLOUD_PERIOD = 90;    // seconds for one cloud to drift across the sky
  const CLOUD_MARGIN_BASE = 720; // px off-screen at each wrap on the 1080-wide reference
  // The sky/cloud layer fills the whole viewport (it isn't inside the scaled
  // stage), so cloud pixel sizes are scaled by the viewport width relative to
  // the 1080px design width. This keeps clouds the same size *relative to the
  // screen* on any device — identical to now on a 1080-wide display, and not
  // oversized on a phone.
  const CLOUD_REF_W = 1080;
  const cloudScale = () => (window.innerWidth || CLOUD_REF_W) / CLOUD_REF_W;
  const cloudMargin = () => CLOUD_MARGIN_BASE * cloudScale();
  let cloudObjs = [];         // { el, x } for each live cloud, moved each frame
  let cloudDensity = 20;      // current density %, used for the overcast haze
  let lastBuiltWidth = 0;     // viewport width the sky clouds were last sized for

  // How opaque the overcast sheet is for a given density (0 until ~30%, rising
  // to a near-solid deck at 100% so it reads as mostly overcast).
  function overcastLevel(d) { return Math.max(0, (d - 30) / 70) * 0.88; }

  function buildClouds(pct) {
    if (!el.clouds) return;
    const d = Math.max(0, Math.min(100, Number(pct) || 0));
    cloudDensity = d;
    const count = d <= 0 ? 0 : Math.round(Math.pow(d / 100, CLOUD_EXP) * MAX_CLOUDS);
    const vw = window.innerWidth || 1080;
    const sc = cloudScale();            // size clouds relative to the screen width
    const margin = cloudMargin();
    const span = vw + margin;           // wrap distance (entry-to-entry)
    el.clouds.innerHTML = '';
    cloudObjs = [];
    lastBuiltWidth = vw;
    for (let i = 0; i < count; i++) {
      const s = CLOUD_SPECS[i];
      const c = document.createElement('div');
      c.className = 'cloud';
      if (!skyCloudBgs[i]) skyCloudBgs[i] = randomCloudBackground();
      c.style.background = skyCloudBgs[i];
      c.style.top = s.top + '%';
      c.style.width = (s.w * sc).toFixed(1) + 'px';
      c.style.height = (s.h * sc).toFixed(1) + 'px';
      c.style.opacity = s.op;
      // Phase the clouds evenly across one cycle so they're always spaced a
      // constant time apart — at higher density they enter the left sooner
      // (interval = CLOUD_PERIOD / count).
      const x = (i / Math.max(1, count)) * span - margin;
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
    const span = vw + cloudMargin();
    const dx = (span / CLOUD_PERIOD) * (dtMs / 1000);
    for (const c of arr) {
      c.x += dx;
      if (c.x > vw) c.x -= span;   // fully past the right edge -> back to the left
      c.el.style.transform = `translateX(${c.x}px)`;
    }
  }
  function moveClouds(dtMs) { driftCloudArray(cloudObjs, dtMs); }

  /* ---------- Screensaver clouds ----------
     Clouds spawn one at a time from the left at random heights / sizes / speeds
     and drift across over everything, so they stream in naturally and build up
     to full-screen coverage. No backdrop — just more clouds on top. */
  let ssClouds = [];          // { el, x, speed }
  let screensaverOn = false;
  let ssSpawnAccum = 0;       // ms since the last spawn
  let ssNextSpawn = 0;        // ms until the next spawn
  let ssMax = 40;             // cap on simultaneous clouds (user-settable)
  const ssRand = (a, b) => a + Math.random() * (b - a);

  function spawnScreensaverCloud() {
    if (!el.screensaver || ssClouds.length >= ssMax) return;
    const vw = window.innerWidth || 1080;
    const vh = window.innerHeight || 1920;
    const w = ssRand(170, 805) * cloudScale();   // scaled to the screen (proportional on any device)
    const h = Math.round(w * 0.36);
    const c = document.createElement('div');
    c.className = 'cloud';
    c.style.background = randomCloudBackground();  // a fresh unique shape each spawn
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    // Random height — allowed to straddle the top/bottom edges so coverage runs
    // right to the edges (and never looks like neat rows).
    c.style.top = Math.round(ssRand(-h * 0.5, vh - h * 0.5)) + 'px';
    c.style.opacity = ssRand(0.05, 0.34).toFixed(2);     // inverse of the normal range (1 - 0.66..0.95)
    const x = -(w + 60);                                 // start just off the left
    // Gentle vertical oscillation (~25% of height) so the path curves, not linear.
    const amp = h * 0.25;
    const phase = Math.random() * Math.PI * 2;
    const omega = (Math.PI * 2) / ssRand(6, 14);         // rad/s — slow bob, varied
    c.style.transform = `translate(${x}px, ${(amp * Math.sin(phase)).toFixed(1)}px)`;
    el.screensaver.appendChild(c);
    const speed = (vw + w + 140) / ssRand(50, 95);       // px/sec, varied per cloud
    ssClouds.push({ el: c, x, speed, amp, phase, omega });
  }

  function moveScreensaver(dtMs) {
    const vw = window.innerWidth || 1080;
    const dts = dtMs / 1000;
    for (let i = ssClouds.length - 1; i >= 0; i--) {
      const c = ssClouds[i];
      c.x += c.speed * dts;
      if (c.x > vw) { c.el.remove(); ssClouds.splice(i, 1); continue; } // off the right -> gone
      c.phase += c.omega * dts;
      const y = c.amp * Math.sin(c.phase);
      c.el.style.transform = `translate(${c.x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  /* ---------- Screensaver firefly ----------
     A single purple firefly (ported from the purplefirefly-pump screensaver)
     wanders the screen along chained quadratic Bézier curves, fading in and
     rotating to face its direction of travel. Drifts above the clouds. */
  const FLY = {
    SPEED: 1,              // movement speed multiplier
    SIZE_PERCENT: 12,      // render size as % of viewport width
    BOUNCE_MARGIN: 50,     // px from each edge the firefly turns back at
    ROTATION_OFFSET: 90,   // deg so the art (nose-up) faces its travel direction
    FADE_IN_MS: 800,       // fade-in on (re)spawn
  };

  class Firefly {
    constructor() {
      this.el = null;
      this.reset();
    }
    reset() {
      this.x = 0; this.y = 0;
      this.velocityX = 0; this.velocityY = 0;
      this.rotation = 0;
      this.opacity = 0;
      this.age = 0;
      this.curveProgress = 0;
      this.curveStartX = 0; this.curveStartY = 0;
      this.curveControlX = 0; this.curveControlY = 0;
      this.targetX = 0; this.targetY = 0;
    }
    initialise(startX, startY) {
      this.reset();
      this.x = startX; this.y = startY;

      const speed = 100 * FLY.SPEED;
      const initialAngle = Math.random() * Math.PI * 2;
      const distance = 200 + Math.random() * 300;          // 200-500px
      this.targetX = startX + Math.cos(initialAngle) * distance;
      this.targetY = startY + Math.sin(initialAngle) * distance;

      // Control point mid-way with a small perpendicular offset (a gentle arc).
      const midX = (startX + this.targetX) / 2;
      const midY = (startY + this.targetY) / 2;
      const perpDist = 30 + Math.random() * 60;
      const side = Math.random() < 0.5 ? 1 : -1;
      const perpAngle = initialAngle + side * Math.PI / 2 + (Math.random() - 0.5) * Math.PI / 4;
      this.curveControlX = midX + Math.cos(perpAngle) * perpDist;
      this.curveControlY = midY + Math.sin(perpAngle) * perpDist;

      this.curveStartX = startX; this.curveStartY = startY;

      const angle = Math.atan2(this.targetY - this.y, this.targetX - this.x);
      this.velocityX = Math.cos(angle) * speed;
      this.velocityY = Math.sin(angle) * speed;
      this.rotation = angle * 180 / Math.PI + FLY.ROTATION_OFFSET;
    }
    update(deltaTime, width, height) {
      // Fade in
      this.age += deltaTime;
      this.opacity = Math.min(1, this.age / (FLY.FADE_IN_MS / 1000));

      // Advance along the current curve.
      const curveSpeed = 0.5 * FLY.SPEED;
      let p = this.curveProgress + curveSpeed * deltaTime;

      // At 80% of the leg, plot the next one, entering along the current tangent.
      if (p >= 0.8) {
        const t = 0.8;
        const tangentX = -2 * (1 - t) * this.curveStartX + 2 * (1 - 2 * t) * this.curveControlX + 2 * t * this.targetX;
        const tangentY = -2 * (1 - t) * this.curveStartY + 2 * (1 - 2 * t) * this.curveControlY + 2 * t * this.targetY;
        const tangMag = Math.sqrt(tangentX * tangentX + tangentY * tangentY) || 1;
        const normTanX = tangentX / tangMag;
        const normTanY = tangentY / tangMag;

        const targetDistance = 140 + Math.random() * 200;   // 140–340px legs — retargets sooner
        // Turn the heading a moderate random amount each leg so it wanders on its
        // own, instead of holding a near-straight line until it reaches an edge.
        const angleVariation = (Math.random() - 0.5) * (Math.PI / 2.6);  // ±~35°
        const newAngle = Math.atan2(normTanY, normTanX) + angleVariation;

        const newTargetX = this.x + Math.cos(newAngle) * targetDistance;
        const newTargetY = this.y + Math.sin(newAngle) * targetDistance;

        const m = FLY.BOUNCE_MARGIN;
        this.targetX = Math.max(m, Math.min(width - m, newTargetX));
        this.targetY = Math.max(m, Math.min(height - m, newTargetY));

        // Control point sits ON the entry tangent so the new leg leaves in the
        // exact direction the previous one arrived — the heading is continuous
        // (no kink). The leg still curves: it bends smoothly from that tangent
        // toward the re-aimed target, so the turn happens gradually.
        const controlDist = targetDistance / 2;
        this.curveControlX = this.x + normTanX * controlDist;
        this.curveControlY = this.y + normTanY * controlDist;
        this.curveStartX = this.x;
        this.curveStartY = this.y;
        p = 0;
      }

      // Position + velocity from the quadratic Bézier at progress p.
      const t = p;
      this.x = (1 - t) * (1 - t) * this.curveStartX + 2 * (1 - t) * t * this.curveControlX + t * t * this.targetX;
      this.y = (1 - t) * (1 - t) * this.curveStartY + 2 * (1 - t) * t * this.curveControlY + t * t * this.targetY;
      this.velocityX = -2 * (1 - t) * this.curveStartX + 2 * (1 - 2 * t) * this.curveControlX + 2 * t * this.targetX;
      this.velocityY = -2 * (1 - t) * this.curveStartY + 2 * (1 - 2 * t) * this.curveControlY + 2 * t * this.targetY;
      this.rotation = Math.atan2(this.velocityY, this.velocityX) * 180 / Math.PI + FLY.ROTATION_OFFSET;

      this.curveProgress = p;
    }
  }

  let firefly = null;        // the single screensaver firefly, live only while on
  let fireflyEnabled = true; // user-settable; off hides it from the screensaver

  function spawnFirefly() {
    if (!el.screensaver || !fireflyEnabled) return;
    const vw = window.innerWidth || 1080;
    const vh = window.innerHeight || 1920;
    const size = Math.round(vw * FLY.SIZE_PERCENT / 100);
    const d = document.createElement('div');
    d.className = 'screensaver-firefly';
    d.style.width = size + 'px';
    d.style.height = size + 'px';
    const img = document.createElement('img');
    img.src = 'assets/PurpleFirefly256.png';
    img.alt = 'Purple firefly';
    d.appendChild(img);
    el.screensaver.appendChild(d);
    firefly = new Firefly();
    firefly.el = d;
    firefly.initialise(vw / 2, vh / 2);
  }

  function moveFirefly(dtMs) {
    if (!firefly) return;
    firefly.update(dtMs / 1000, window.innerWidth || 1080, window.innerHeight || 1920);
    const d = firefly.el;
    d.style.opacity = firefly.opacity.toFixed(3);
    d.style.transform =
      `translate(${(firefly.x).toFixed(1)}px, ${(firefly.y).toFixed(1)}px) translate(-50%, -50%) rotate(${firefly.rotation.toFixed(1)}deg)`;
  }

  /* Spawn new clouds on a randomized cadence + drift the existing ones. */
  function tickScreensaver(dtMs) {
    if (screensaverOn) {
      ssSpawnAccum += dtMs;
      if (ssSpawnAccum >= ssNextSpawn) {
        ssSpawnAccum = 0;
        ssNextSpawn = ssRand(700, 1900);  // ms between individual spawns
        spawnScreensaverCloud();
      }
    }
    if (ssClouds.length) moveScreensaver(dtMs);
    if (firefly) moveFirefly(dtMs);
  }

  /* Show/hide the screensaver cloud layer. */
  function setScreensaver(on) {
    if (!el.screensaver || on === screensaverOn) return;
    screensaverOn = on;
    if (on) {
      el.screensaver.classList.add('on');
      ssSpawnAccum = 0; ssNextSpawn = 0;   // first cloud enters right away
      spawnFirefly();                      // a single purple firefly joins the drift
    } else {
      el.screensaver.classList.remove('on');
      firefly = null;                      // stop animating; element fades + is cleared below
      // existing clouds keep drifting + fading, then are cleared
      setTimeout(() => {
        if (!screensaverOn) {
          ssClouds.forEach((c) => c.el.remove());
          ssClouds = [];
          if (el.screensaver) el.screensaver.innerHTML = '';
        }
      }, 1100);
    }
  }

  /* ---------- Shooting stars ----------
     Occasional meteors streak across the night sky. They live inside #stars so
     they inherit its opacity — only visible (and only spawned) when the auto
     starfield is showing. Count + frequency are user-settable. */
  let starsVisibility = 0;     // current #stars opacity, set in applyAutoTheme
  let shootFreq = 9;           // avg seconds between shooting-star events (0 = off)
  let shootCount = 1;          // up to this many streaks per event (0 = off)
  let shootAccum = 0;          // seconds since the last event
  let shootNext = 0;           // seconds until the next event
  let liveShooting = 0;        // currently animating, capped for safety
  const SHOOT_CAP = 12;

  function scheduleNextShoot() {
    shootAccum = 0;
    shootNext = shootFreq * (0.5 + Math.random());   // jitter the interval ±50%
  }

  function spawnShootingStar() {
    if (!el.stars || liveShooting >= SHOOT_CAP) return;
    const vw = window.innerWidth || 1080;
    const vh = window.innerHeight || 1920;
    const tail = ssRand(90, 190);                    // streak length, px
    const sx = ssRand(0.08, 0.85) * vw;              // start point in the upper sky
    const sy = ssRand(0.04, 0.50) * vh;
    const dir = Math.random() < 0.5 ? 1 : -1;        // veer left or right
    const ang = (15 + Math.random() * 35) * Math.PI / 180;  // 15–50° below horizontal
    const dist = ssRand(0.30, 0.60) * vw;            // travel distance
    const tx = Math.cos(ang) * dist * dir;
    const ty = Math.sin(ang) * dist;
    const d = document.createElement('div');
    d.className = 'shooting-star';
    d.style.width = Math.round(tail) + 'px';
    d.style.left = Math.round(sx - tail) + 'px';     // head (right end) sits at sx
    d.style.top = Math.round(sy) + 'px';
    d.style.setProperty('--tx', Math.round(tx) + 'px');
    d.style.setProperty('--ty', Math.round(ty) + 'px');
    d.style.setProperty('--rot', (Math.atan2(ty, tx) * 180 / Math.PI).toFixed(1) + 'deg');
    d.style.animation = `shoot ${ssRand(0.6, 1.25).toFixed(2)}s linear forwards`;
    d.addEventListener('animationend', () => { d.remove(); liveShooting--; });
    el.stars.appendChild(d);
    liveShooting++;
  }

  function tickShootingStars(dtMs) {
    // Only while the night starfield is actually visible.
    if (document.body.dataset.theme !== 'auto' || starsVisibility < 0.15) return;
    if (!(shootFreq > 0) || shootCount < 1) return;
    shootAccum += dtMs / 1000;
    if (shootAccum >= shootNext) {
      const n = 1 + Math.floor(Math.random() * shootCount);  // 1..count streaks
      for (let i = 0; i < n; i++) spawnShootingStar();
      scheduleNextShoot();
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
    starsVisibility = stars;   // gates shooting-star spawning
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

    // The going train's power scales how fast time actually advances: 1 = full,
    // 0 = stopped. main.js lowers it as the time weight winds down (see
    // setTimePower), so the hands and seconds slow to a halt rather than freezing.
    const dtSim = dt * speed * timePower;
    simNow += dtSim;
    const date = new Date(simNow);

    updateHands(date);
    updateDate(date);
    updateMoon(date);
    if (document.body.dataset.theme === 'auto') { applyAutoTheme(date); moveClouds(dt); }
    tickScreensaver(dt); // screensaver clouds (any theme)
    tickShootingStars(dt); // night-sky meteors (auto theme, when stars show)

    // Pass both simulated and real elapsed ms so consumers can advance
    // time-based state (weights) and real-time animations (winding).
    if (onTick) onTick(date, speed, dtSim, dt);
    requestAnimationFrame(frame);
  }

  /* ---------- Viewport scaling to fit 1080x1920 ---------- */
  function fit() {
    const scale = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
    el.stage.style.transform = `scale(${scale})`;
    // Re-size the sky clouds when the viewport width changes (e.g. a phone
    // rotating) so they stay proportional. Only rebuild on an actual width
    // change to avoid reshuffling them during height-only changes.
    const vw = window.innerWidth || 1080;
    if (vw !== lastBuiltWidth) buildClouds(cloudDensity);
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
  /* Going-train power (0..1): scales how fast time advances so the clock can
     wind down to a stop instead of freezing instantly. */
  function setTimePower(p) { timePower = Math.max(0, Math.min(1, Number(p))); }
  function setTime(ms) { simNow = ms; }
  function getTime() { return simNow; }
  function setMoonPhase(p) { moonOverride = (p == null ? null : ((p % 1) + 1) % 1); }
  function setOnTick(fn) { onTick = fn; }
  function showSeconds(show) { el.subSeconds.style.display = show ? '' : 'none'; }
  function setCloudDensity(pct) { buildClouds(pct); }
  function setScreensaverClouds(n) { if (Number(n) > 0) ssMax = Math.round(Number(n)); }
  /* Configure shooting stars: avg seconds between events (0 = off) and how many
     streaks can appear per event (0 = off). */
  function setShootingStars(freq, count) {
    shootFreq = Math.max(0, Number(freq) || 0);
    shootCount = Math.max(0, Math.round(Number(count) || 0));
    scheduleNextShoot();
  }
  /* Toggle the screensaver firefly. Applies live if the screensaver is showing. */
  function setFirefly(on) {
    fireflyEnabled = !!on;
    if (!screensaverOn) return;
    if (fireflyEnabled && !firefly) spawnFirefly();
    else if (!fireflyEnabled && firefly) { firefly.el.remove(); firefly = null; }
  }

  return { init, setSpeed, getSpeed, setTimePower, setTime, getTime, setMoonPhase, setOnTick, showSeconds, setCloudDensity, setScreensaver, setScreensaverClouds, setFirefly, setShootingStars };
})();
