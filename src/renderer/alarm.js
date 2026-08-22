// src/renderer/alarm.js — the noise. Everything is synthesised with WebAudio
// oscillators: no audio files to ship, no codec to depend on, and the volume
// stays under our control instead of whatever a sample was mastered at.
//
// A "bar" is one repetition of a sound (a siren sweep, a burst of beeps). The
// alarm schedules bars back to back until it is stopped or its length runs out,
// so a held alarm never drifts and never overlaps itself.

export const SOUNDS = ['siren', 'beep', 'pulse', 'chime'];

const BARS = {
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
    return this.ctx;
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
