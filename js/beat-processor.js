/* ===========================================================
   beat-processor.js — AudioWorkletProcessor that listens to a
   filtered microphone stream and picks out discrete tick/tock
   transients (a real pendulum clock's escapement) as timestamped
   "beat" events, for js/beat-timer.js to turn into a rate/drift
   measurement. Runs on the real-time audio thread, so beat
   timestamps (`currentTime`) are sample-accurate and immune to
   main-thread jank (rAF throttling, GC pauses, etc).

   Simple, explainable envelope-follower onset detection — no FFT,
   no ML — in the same spirit as the synthesized tick in audio.js.
   =========================================================== */

class BeatDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.envelope = 0;
    this.noiseFloor = 0.001;
    this.lastBeatTime = -1;
    this.aboveThreshold = false;
    this.targetBpm = 60;
    this.levelCounter = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.type === 'config' && msg.targetBpm > 0) {
        this.targetBpm = msg.targetBpm;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || ch.length === 0) return true;

    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const blockRms = Math.sqrt(sum / ch.length);

    // Fast-attack / slower-release envelope: tracks transient peaks
    // without chattering on the decay tail of a click.
    const attackCoeff = blockRms > this.envelope ? 0.6 : 0.15;
    this.envelope += attackCoeff * (blockRms - this.envelope);

    // Adaptive noise floor: rises slowly (so a train of loud ticks
    // doesn't drag it up until the ticks vanish), falls a bit faster
    // (recovers quickly once a transient passes).
    const floorCoeff = blockRms > this.noiseFloor ? 0.001 : 0.01;
    this.noiseFloor += floorCoeff * (blockRms - this.noiseFloor);

    // Ratio-based threshold (adapts to room loudness) plus a small
    // absolute floor (prevents false triggers in near-total silence).
    const threshold = this.noiseFloor * 4 + 0.002;

    const now = currentTime; // worklet-scope sample-accurate audio clock
    // Refractory period scales with the expected beat rate so it stays
    // safely below half the shortest expected inter-beat gap (guards
    // against re-triggering on a tick's own ring-out), capped at 150ms.
    const refractory = Math.min(0.15, (60 / this.targetBpm) * 0.4);

    if (this.envelope > threshold && !this.aboveThreshold &&
        (this.lastBeatTime < 0 || now - this.lastBeatTime > refractory)) {
      this.aboveThreshold = true;
      this.lastBeatTime = now;
      this.port.postMessage({
        type: 'beat',
        t: now,
        amp: this.envelope,
        snr: this.envelope / (this.noiseFloor || 1e-6),
      });
    }
    // Hysteresis: must fall well below threshold before re-arming, so a
    // single loud tick's ring-out can't itself cause a double count.
    if (this.envelope < threshold * 0.6) this.aboveThreshold = false;

    // Throttle the live-meter message (every 8th block, ~21ms @48kHz)
    // so the main thread isn't flooded with postMessage calls.
    this.levelCounter++;
    if (this.levelCounter >= 8) {
      this.levelCounter = 0;
      this.port.postMessage({
        type: 'level',
        envelope: this.envelope,
        noiseFloor: this.noiseFloor,
        threshold,
      });
    }

    return true;
  }
}

registerProcessor('beat-detector', BeatDetector);
