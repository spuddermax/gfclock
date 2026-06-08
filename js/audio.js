/* ===========================================================
   audio.js — chime & strike playback

   Westminster uses a REAL recording: a public-domain capture of a
   Kieninger clockwork (assets/audio/westminster.mp3, from Wikimedia
   Commons). The recording is the full hour chime + strike; we decode
   it once and play sliced segments per quarter / per strike-count.

   Whittington and St. Michael have no freely-licensed recordings, so
   they remain synthesized (bell partials + decay). The escapement
   tick is also synthesized so it can stay in sync with the visible
   tick and the fast-forward speed.
   =========================================================== */

const ChimeAudio = (() => {
  let ctx = null;
  let master = null;
  let tickGain = null;   // independent level for the per-second tick
  let volume = 0.7;
  let tickVolume = 0.6;
  let muted = false;
  let noiseBuf = null;   // cached white-noise buffer for the escapement tick
  let tockToggle = false; // alternate tick/tock pitch like a real escapement

  // ---- Real Westminster recording (decoded sample buffer) ----
  let westBuf = null;        // decoded AudioBuffer, null until loaded
  let westLoading = null;    // in-flight load promise (avoid double fetch)
  const WEST_SRC = 'assets/audio/westminster.mp3';
  /* Segment offsets (seconds) measured from the recording's envelope:
     quiet intro, then 4 chime phrases, a ring-out gap, then the strike. */
  const WMR = {
    chimeStart: 1.70,   // first chime note (skips the silent intro)
    phrase: 3.325,      // duration of one of the 4 phrases
    strikeStart: 16.55, // onset of the single hour strike
    strikeRing: 4.6,    // how long to let each strike ring
    strikeGap: 1.5,     // spacing between successive strikes
  };
  // Phrase count played per quarter (q: 1=:15, 2=:30, 3=:45, 0=hour -> 4).
  function westPhraseCount(q) { return q === 0 ? 4 : q; }

  // Note frequencies (Hz) used by the chime melodies.
  const NOTE = {
    G3: 196.00, A3: 220.00, B3: 246.94,
    C4: 261.63, D4: 293.66, E4: 329.63,
    F4: 349.23, Fs4: 369.99, G4: 392.00,
    Gs4: 415.30, A4: 440.00, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25,
    // Low strike bell
    E3: 164.81, C3: 130.81,
  };

  /* ---- Westminster Quarters: the five canonical phrases ----
     Notes (key of E): E4, F#4, G#4, B3 — each phrase is 4 notes. */
  const WEST = {
    p1: ['Gs4', 'Fs4', 'E4', 'B3'],
    p2: ['E4', 'Gs4', 'Fs4', 'B3'],
    p3: ['E4', 'Fs4', 'Gs4', 'E4'],
    p4: ['Gs4', 'E4', 'Fs4', 'B3'],
    p5: ['B3', 'Fs4', 'Gs4', 'E4'],
  };
  // Which phrases play at each quarter (0=:00, 1=:15, 2=:30, 3=:45)
  const WESTMINSTER = {
    1: [WEST.p1],
    2: [WEST.p2, WEST.p3],
    3: [WEST.p4, WEST.p5, WEST.p1],
    0: [WEST.p2, WEST.p3, WEST.p4, WEST.p5], // top of hour (before the strike)
  };

  /* ---- Whittington (approximation of the longer melody) ---- */
  const WHIT = {
    a: ['D5', 'B4', 'G4', 'D4'],
    b: ['G4', 'A4', 'B4', 'D5'],
    c: ['D5', 'B4', 'A4', 'G4'],
    d: ['B4', 'G4', 'A4', 'D4'],
    e: ['G4', 'D4', 'G4', 'B4'],
    f: ['A4', 'B4', 'G4', 'D4'],
  };
  const WHITTINGTON = {
    1: [WHIT.a],
    2: [WHIT.a, WHIT.b],
    3: [WHIT.c, WHIT.d, WHIT.e],
    0: [WHIT.a, WHIT.b, WHIT.c, WHIT.d, WHIT.e, WHIT.f],
  };

  /* ---- St. Michael (approximation) ---- */
  const STM = {
    a: ['G4', 'A4', 'B4', 'G4'],
    b: ['B4', 'A4', 'G4', 'D4'],
    c: ['D4', 'G4', 'A4', 'B4'],
    d: ['G4', 'B4', 'A4', 'G4'],
  };
  const STMICHAEL = {
    1: [STM.a],
    2: [STM.a, STM.b],
    3: [STM.c, STM.d, STM.a],
    0: [STM.a, STM.b, STM.c, STM.d],
  };

  const TUNES = {
    westminster: WESTMINSTER,
    whittington: WHITTINGTON,
    stmichael: STMICHAEL,
  };

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
      // Tick has its own gain stage feeding master, so it can be balanced
      // against the chimes (and still obeys mute + master volume).
      tickGain = ctx.createGain();
      tickGain.gain.value = tickVolume;
      tickGain.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* Strike a single bell-like note at time `t` (seconds, ctx clock). */
  function bell(freq, t, dur, gainScale = 1) {
    // Inharmonic partials give a metallic bell timbre.
    const partials = [
      { mult: 1.0,  gain: 1.0,  decay: 1.0 },
      { mult: 2.01, gain: 0.5,  decay: 0.85 },
      { mult: 2.97, gain: 0.32, decay: 0.7 },
      { mult: 4.23, gain: 0.18, decay: 0.55 },
      { mult: 5.43, gain: 0.10, decay: 0.45 },
    ];
    partials.forEach((p) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * p.mult;
      const peak = 0.28 * p.gain * gainScale;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * p.decay);
      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + dur * p.decay + 0.05);
    });
  }

  /* Fetch + decode the real Westminster recording (once). */
  function loadWestminster() {
    if (westBuf || westLoading) return westLoading || Promise.resolve(westBuf);
    ensureCtx();
    westLoading = fetch(WEST_SRC)
      .then((r) => r.arrayBuffer())
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { westBuf = buf; return buf; })
      .catch((err) => { console.warn('[ChimeAudio] Westminster load failed:', err); westLoading = null; });
    return westLoading;
  }

  /* Play a slice of the real recording: from `offset` for `dur` seconds. */
  function playSegment(buf, offset, dur, startAt) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    src.start(startAt, offset, dur);
    return src;
  }

  /* Real Westminster chime for a quarter (uses the recorded bells). */
  function playWestminster(quarter) {
    const phrases = westPhraseCount(quarter);
    const dur = phrases * WMR.phrase;
    playSegment(westBuf, WMR.chimeStart, dur, ctx.currentTime + 0.05);
  }

  /* Play a chime melody for a given quarter (0..3). */
  function playChime(tune, quarter) {
    if (tune === 'silent') return;
    ensureCtx();
    if (tune === 'westminster') {
      if (westBuf) { playWestminster(quarter); }
      else { loadWestminster().then(() => { if (westBuf) playWestminster(quarter); }); }
      return;
    }
    // Synthesized tunes (Whittington / St. Michael).
    if (!TUNES[tune]) return;
    const phrases = TUNES[tune][quarter];
    if (!phrases) return;
    const noteDur = 1.05;     // spacing between notes
    let t = ctx.currentTime + 0.05;
    phrases.forEach((phrase) => {
      phrase.forEach((n) => {
        const f = NOTE[n] || 440;
        bell(f, t, 3.2);
        t += noteDur;
      });
      t += 0.35; // small gap between phrases
    });
  }

  /* Short mechanical escapement "tick" — a brief filtered noise transient
     plus a tiny wooden thump. Alternates pitch (tick/tock) each call. */
  function playTick() {
    ensureCtx();
    if (!noiseBuf) {
      const len = Math.floor(ctx.sampleRate * 0.05);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime;
    tockToggle = !tockToggle;

    // Noise transient through a band-pass for the "click".
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = tockToggle ? 2600 : 2000; // tick vs tock
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    const peak = 0.18;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.connect(bp); bp.connect(g); g.connect(tickGain);
    src.start(t);
    src.stop(t + 0.06);

    // Subtle low wooden thump under the click.
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = tockToggle ? 150 : 120;
    og.gain.setValueAtTime(0.12, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    osc.connect(og); og.connect(tickGain);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /* Strike the hour `count` times. Westminster uses the recorded gong;
     the synthesized tunes use a deeper bell. */
  function playStrike(count, tune) {
    ensureCtx();
    if (tune === 'westminster' && westBuf) {
      let t = ctx.currentTime + 0.05;
      for (let i = 0; i < count; i++) {
        playSegment(westBuf, WMR.strikeStart, WMR.strikeRing, t);
        t += WMR.strikeGap;
      }
      return;
    }
    let t = ctx.currentTime + 0.05;
    const gap = 1.4;
    for (let i = 0; i < count; i++) {
      bell(NOTE.E3, t, 4.0, 1.25);
      t += gap;
    }
  }

  /* Duration estimate (seconds) so the strike can be scheduled after the
     chime finishes and the UI can flash appropriately. */
  function chimeDuration(tune, quarter) {
    if (tune === 'silent') return 0;
    if (tune === 'westminster') return westPhraseCount(quarter) * WMR.phrase + 0.4;
    if (!TUNES[tune] || !TUNES[tune][quarter]) return 0;
    const phrases = TUNES[tune][quarter];
    const notes = phrases.reduce((s, p) => s + p.length, 0);
    return notes * 1.05 + phrases.length * 0.35 + 1;
  }

  function setVolume(v) {
    volume = v;
    if (master && !muted) master.gain.value = volume;
  }
  function setTickVolume(v) {
    tickVolume = v;
    if (tickGain) tickGain.gain.value = tickVolume;
  }
  function setMuted(m) {
    muted = m;
    if (master) master.gain.value = muted ? 0 : volume;
  }
  /* Unlock audio on first user gesture (browsers require this) and
     start preloading the Westminster recording so it's ready to play. */
  function unlock() { ensureCtx(); loadWestminster(); }

  return { playChime, playStrike, playTick, chimeDuration, setVolume, setTickVolume, setMuted, unlock };
})();
