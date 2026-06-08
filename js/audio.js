/* ===========================================================
   audio.js — chime & strike playback

   CHIMES: all three tunes (Westminster / Whittington / St. Michael)
   are played note-by-note from REAL tubular-bell samples
   (assets/audio/bells/*.mp3 — CC0 public domain, FreePats / Versilian
   Community Sample Library). Each note is a one-shot that rings its
   FULL natural decay and overlaps the next, so chimes fade out
   naturally instead of being truncated. Notes are pitched by detuning
   the nearest sampled pitch (all within one semitone).

   HOUR STRIKE: the public-domain Kieninger gong from the original
   recording (assets/audio/westminster.mp3), which already rings out
   naturally — authentically a different timbre from the chime bells.

   The escapement tick is synthesized so it can stay in sync with the
   visible tick and the fast-forward speed.
   =========================================================== */

const ChimeAudio = (() => {
  let ctx = null;
  let master = null;
  let tickGain = null;   // independent level for the per-second tick
  let bellComp = null;   // compressor bus for overlapping bell notes
  let volume = 0.7;
  let tickVolume = 0.6;
  let muted = false;
  let noiseBuf = null;   // cached white-noise buffer for the escapement tick
  let tockToggle = false; // alternate tick/tock pitch like a real escapement

  // ---- Hour-strike recording (the Kieninger gong, decoded buffer) ----
  let westBuf = null;        // decoded AudioBuffer, null until loaded
  let westLoading = null;    // in-flight load promise (avoid double fetch)
  const WEST_SRC = 'assets/audio/westminster.mp3';
  /* Strike segment offsets (seconds) measured from the recording. */
  const WMR = {
    strikeStart: 16.55, // onset of the single hour strike
    strikeRing: 4.6,    // how long to let each strike ring
  };
  // Absolute spacing (seconds) between successive hour strikes — user-settable.
  let strikeGapSec = 1.5;

  // ---- Tubular-bell note samples (CC0, FreePats / VCSL) ----
  const BELL_DIR = 'assets/audio/bells/';
  const BELL_SAMPLES = ['C4', 'D4', 'E4', 'Fs4', 'Gs4', 'As4', 'C5', 'D5', 'E5'];
  const bellBufs = {};       // note name -> AudioBuffer
  let bellsLoading = null;
  let bellsLoaded = false;
  // Chime rhythm. `tempo` scales the note-to-note spacing (higher = faster).
  // The pause between phrases is a separate, absolute value the user sets
  // directly (in seconds) so the quarters don't run together — it is NOT
  // affected by tempo, so "set it to 1s" means exactly 1s.
  const BASE_NOTE_DUR = 0.95; // base spacing between notes (scaled by tempo)
  let tempo = 1.0;            // 1 = normal; <1 slower, >1 faster
  let phraseGapSec = 1.0;     // absolute pause between phrases (seconds)
  const noteDur = () => BASE_NOTE_DUR / tempo;
  const phraseGap = () => phraseGapSec;

  // Note frequencies (Hz) used by the chime melodies + sample pitches.
  const NOTE = {
    G3: 196.00, A3: 220.00, B3: 246.94,
    C4: 261.63, D4: 293.66, E4: 329.63,
    F4: 349.23, Fs4: 369.99, G4: 392.00,
    Gs4: 415.30, A4: 440.00, As4: 466.16, B4: 493.88,
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
      // Bell notes run through a gentle compressor so many overlapping
      // ring-outs don't sum into digital clipping.
      bellComp = ctx.createDynamicsCompressor();
      bellComp.threshold.value = -16;
      bellComp.knee.value = 24;
      bellComp.ratio.value = 3;
      bellComp.attack.value = 0.003;
      bellComp.release.value = 0.5;
      bellComp.connect(master);
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

  /* Play a slice of the real recording from `offset` for `dur` seconds,
     through its own gain stage with a smooth release fade. The fade means a
     segment never ends abruptly: it decays gracefully and overlaps anything
     that starts before it has faded out. */
  function playSegment(buf, offset, dur, startAt, fadeOut = 0.5) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(master);
    const end = startAt + dur;
    const fade = Math.min(fadeOut, dur * 0.5);
    g.gain.setValueAtTime(1, Math.max(startAt, end - fade));
    g.gain.linearRampToValueAtTime(0.0001, end);
    src.start(startAt, offset, dur);
    src.stop(end + 0.03);
    return src;
  }

  /* Lazy-load the tubular-bell note samples (once). Individual fetch
     failures are tolerated (that note falls back to synth). */
  function loadBells() {
    if (bellsLoading) return bellsLoading;
    ensureCtx();
    bellsLoading = Promise.all(BELL_SAMPLES.map((n) =>
      fetch(BELL_DIR + n + '.mp3')
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buf) => { bellBufs[n] = buf; })
        .catch((e) => console.warn('[ChimeAudio] bell load failed:', n, e))
    )).then(() => { bellsLoaded = true; });
    return bellsLoading;
  }

  /* Find the nearest sampled pitch to a note and the detune (cents) to it. */
  function nearestBell(noteName) {
    const target = NOTE[noteName];
    if (!target) return null;
    let best = null, bestCents = Infinity;
    for (const s of BELL_SAMPLES) {
      const cents = 1200 * Math.log2(target / NOTE[s]);
      if (Math.abs(cents) < Math.abs(bestCents)) { best = s; bestCents = cents; }
    }
    return bellBufs[best] ? { buf: bellBufs[best], cents: bestCents } : null;
  }

  /* Play one bell note at ctx time `when`, ringing its FULL natural decay
     (no stop()/duration — the sample's own tail provides the fade-out). */
  function playBellNote(noteName, when, gain = 0.55) {
    const pick = nearestBell(noteName);
    if (!pick) {                              // samples not ready -> synth fallback
      if (NOTE[noteName]) bell(NOTE[noteName], when, 3.2);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = pick.buf;
    src.detune.value = pick.cents;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(bellComp);
    src.start(when);
  }

  /* Play a chime melody for a given quarter (0..3) using real bell samples. */
  function playChime(tune, quarter) {
    if (tune === 'silent') return;
    ensureCtx();
    const map = TUNES[tune];
    if (!map) return;
    const phrases = map[quarter];
    if (!phrases) return;
    const run = () => {
      let t = ctx.currentTime + 0.05;
      phrases.forEach((phrase) => {
        phrase.forEach((n) => { playBellNote(n, t); t += noteDur(); });
        t += phraseGap();
      });
    };
    if (bellsLoaded) run();
    else loadBells().then(run);
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
        t += strikeGapSec;
      }
      return;
    }
    let t = ctx.currentTime + 0.05;
    for (let i = 0; i < count; i++) {
      bell(NOTE.E3, t, 4.0, 1.25);
      t += strikeGapSec;
    }
  }

  /* Time (seconds) until the chime's last note onset, so the hour strike is
     scheduled right after the melody (its natural ring-out then overlaps the
     strike). Not the full ring tail — we don't want to wait ~7s. */
  function chimeDuration(tune, quarter) {
    if (tune === 'silent' || !TUNES[tune] || !TUNES[tune][quarter]) return 0;
    const phrases = TUNES[tune][quarter];
    const notes = phrases.reduce((s, p) => s + p.length, 0);
    return notes * noteDur() + phrases.length * phraseGap();
  }

  /* Set the chime tempo. `t` is a multiplier: 1 = normal, <1 slower (more
     space between notes/phrases), >1 faster. Clamped to a sane range. */
  function setTempo(t) {
    if (!(t > 0)) return;
    tempo = Math.max(0.4, Math.min(2.0, t));
  }

  /* Set the absolute pause between chime phrases, in seconds. */
  function setPhraseGap(sec) {
    if (!(sec >= 0)) return;
    phraseGapSec = Math.max(0, Math.min(5, sec));
  }

  /* Set the absolute spacing between hour strikes, in seconds. */
  function setStrikeGap(sec) {
    if (!(sec >= 0)) return;
    strikeGapSec = Math.max(0.2, Math.min(5, sec));
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
  /* Unlock audio on first user gesture (browsers require this) and start
     preloading the bell samples + the strike recording so they're ready. */
  function unlock() { ensureCtx(); loadBells(); loadWestminster(); }

  return { playChime, playStrike, playTick, chimeDuration, setVolume, setTickVolume, setMuted, setTempo, setPhraseGap, setStrikeGap, unlock };
})();
