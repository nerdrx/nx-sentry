// src/renderer/alarm.js — the noise. Everything is synthesised with WebAudio
// oscillators: no audio files to ship, no codec to depend on, and the volume
// stays under our control instead of whatever a sample was mastered at.
//
// A "bar" is one repetition of a sound (a siren sweep, a burst of beeps). The
// alarm schedules bars back to back until it is stopped or its length runs out,
// so a held alarm never drifts and never overlaps itself.

export const SOUNDS = ['siren', 'beep', 'pulse', 'chime'];

export const BARS = {
  // Rising/falling two-tone sweep — the classic "something is wrong" sound.
  siren(ctx, out, t0) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(520, t0);
    osc.frequency.exponentialRampToValueAtTime(980, t0 + 0.55);
    osc.frequency.exponentialRampToValueAtTime(520, t0 + 1.1);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.5, t0 + 0.06);
    gain.gain.setValueAtTime(0.5, t0 + 1.0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.16);
    osc.connect(gain).connect(out);
    osc.start(t0);
    osc.stop(t0 + 1.2);
    return 1.2;
  },

  // Three sharp beeps then a gap — reads as "attention", not "emergency".
  beep(ctx, out, t0) {
    for (let i = 0; i < 3; i++) {
      const at = t0 + i * 0.22;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1046, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.34, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      osc.connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + 0.15);
    }
    return 1.0;
  },

  // Low throb — the one you can leave running without going mad.
  pulse(ctx, out, t0) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(184, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    for (let i = 0; i < 2; i++) {
      const at = t0 + i * 0.5;
      gain.gain.exponentialRampToValueAtTime(0.6, at + 0.09);
      gain.gain.exponentialRampToValueAtTime(0.02, at + 0.42);
    }
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);
    osc.connect(gain).connect(out);
    osc.start(t0);
    osc.stop(t0 + 1.05);
    return 1.05;
  },

  // Two struck bell tones — for watching something you merely want to know about.
  chime(ctx, out, t0) {
    const strike = (at, base) => {
      [1, 2.01, 2.98].forEach((mult, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(base * mult, at);
        const peak = 0.34 / (i + 1.3);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.1 - i * 0.22);
        osc.connect(gain).connect(out);
        osc.start(at);
        osc.stop(at + 1.2);
      });
    };
    strike(t0, 880);
    strike(t0 + 0.28, 1174);
    return 1.6;
  },
};

export class Alarm {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.timer = null;
    this.playing = false;
    this.volume = 0.6;
    this.outputId = ''; // '' = whatever the system default is
    this.onError = null;
  }

  /** Create (or resume) the audio graph. Safe to call on every user gesture. */
  ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      try {
        this.ctx = new Ctx();
      } catch (err) {
        // No audio device at all (a headless run, a stripped container). The
        // sentry still watches, notifies and flashes — it just cannot beep.
        this.ctx = null;
        this.onError?.(err);
        return null;
      }
      this.master = this.ctx.createGain();
      const soften = this.ctx.createBiquadFilter();
      soften.type = 'lowpass';
      soften.frequency.value = 5200; // takes the glass off the square waves
      this.master.connect(soften).connect(this.ctx.destination);
      this.master.gain.value = this.volume;
    }
    // Browsers start the context suspended until a gesture; arming is one.
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    if (this.outputId && this.ctx.sinkId !== this.outputId) this.setOutputDevice(this.outputId);
    return this.ctx;
  }

  /**
   * Send the alarm to a specific output device rather than the system default.
   *
   * This is not a nicety: a machine whose real listening chain is an effects
   * sink, a headset, or a capture interface will happily play an alarm into a
   * device nobody is listening to, and the app looks broken while working
   * perfectly. '' restores the system default.
   */
  async setOutputDevice(id) {
    this.outputId = typeof id === 'string' ? id : '';
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return false;
    try {
      await this.ctx.setSinkId(this.outputId);
      return true;
    } catch (err) {
      // A device that has been unplugged since it was chosen ends up here.
      this.onError?.(err);
      return false;
    }
  }

  /** Whether this build can route audio at all (Chromium 110+ / Electron 22+). */
  get canRoute() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    return !!Ctx && typeof Ctx.prototype.setSinkId === 'function';
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, Number(v) || 0));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Start sounding. `hold` keeps it going until stop(); otherwise it stops
   * itself after `durationMs`.
   */
  start(sound, { volume, durationMs = 4000, hold = false } = {}) {
    const ctx = this.ensure();
    if (!ctx) return false;
    if (volume != null) this.setVolume(volume);
    this.stop();
    this.playing = true;

    const bar = BARS[sound] || BARS.siren;
    const endAt = hold ? Infinity : performance.now() + durationMs;

    const schedule = () => {
      if (!this.playing) return;
      let seconds = 1.2;
      try {
        seconds = bar(ctx, this.master, ctx.currentTime + 0.02);
      } catch (err) {
        this.playing = false;
        this.onError?.(err);
        return;
      }
      // Stop at the end of the bar that crosses the deadline: cutting a siren
      // off mid-sweep sounds like a fault, not a finish.
      if (performance.now() + seconds * 1000 >= endAt) {
        this.timer = setTimeout(() => this.stop(), seconds * 1000);
      } else {
        this.timer = setTimeout(schedule, seconds * 1000);
      }
    };
    schedule();
    return true;
  }

  /**
   * Play one bar and MEASURE what actually came out of the graph, by tapping
   * the master with an analyser. An alarm you cannot hear is the one failure
   * this app must never sit quietly on, and "did the code run" is not the same
   * question as "did sound come out" — a suspended context, a muted stream or a
   * dead output device all run the code perfectly and produce silence.
   */
  async check(sound, volume) {
    const ctx = this.ensure();
    if (!ctx) return { ok: false, reason: 'no-audio', state: 'none', peak: 0 };
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* reported below via state */
      }
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // The master still feeds the real output; the analyser is a second branch
    // off it, so this measures the same signal the speakers get.
    this.master.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    this.start(sound, { volume, durationMs: 900 });
    const until = performance.now() + 1000;
    while (performance.now() < until) {
      await new Promise((r) => setTimeout(r, 40));
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
      }
    }
    try {
      this.master.disconnect(analyser);
    } catch {
      /* already gone */
    }
    return {
      ok: ctx.state === 'running' && peak > 0.01,
      sinkId: typeof ctx.sinkId === 'string' ? ctx.sinkId : '',
      reason: ctx.state !== 'running' ? 'suspended' : peak > 0.01 ? 'ok' : 'silent',
      state: ctx.state,
      peak: Number(peak.toFixed(3)),
      sampleRate: ctx.sampleRate,
    };
  }

  /** Is the audio graph in a state that can actually make noise right now? */
  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** One bar, for the "test the alarm" button. */
  test(sound, volume) {
    return this.start(sound, { volume, durationMs: 1, hold: false });
  }

  stop() {
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export default { Alarm, SOUNDS };
