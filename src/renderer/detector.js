// src/renderer/detector.js — the motion core. Pure functions and one small
// state machine over plain typed arrays: no DOM, no canvas, no Electron, so
// `node --test` exercises exactly the code that runs in the app.
//
// The pipeline is deliberately dumb and cheap: the renderer draws the WATCHED
// REGION ONLY into a small offscreen canvas (a few hundred pixels wide), so a
// frame is a few thousand samples. We grayscale it, compare it to the previous
// frame pixel by pixel, and call a pixel "moving" when its luma changed by more
// than `pixelThreshold`. The fraction of moving pixels is the motion ratio, and
// everything the UI shows is a view of that one number.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Map the single user-facing sensitivity slider (0..100) onto the two knobs the
 * detector actually has. Both move together on purpose: a sensitive setting
 * should notice both fainter changes (lower luma threshold) and smaller ones
 * (lower area threshold).
 *
 * 0   → luma must move 48/255 across 2.5% of the region (a person walking past)
 * 100 → luma must move 8/255 across 0.06% of the region (a cursor twitch)
 */
export function sensitivityToParams(sensitivity) {
  const s = clamp(Number(sensitivity) || 0, 0, 100) / 100;
  const pixelThreshold = Math.round(48 - 40 * s);
  // Geometric, not linear: the interesting range is all down at the small end,
  // and a linear slider would spend 90% of its travel between "huge" and "big".
  const minAreaPct = 2.5 * Math.pow(0.06 / 2.5, s);
  return { pixelThreshold, minAreaPct: Number(minAreaPct.toFixed(4)) };
}

/**
 * RGBA bytes → one luma byte per pixel (BT.601 weights, integer math).
 * `out` is reused across frames by the caller; allocating per frame at 8fps is
 * how you turn a background tool into a GC machine.
 */
export function toGray(rgba, out) {
  const n = rgba.length >> 2;
  const gray = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return gray;
}

/**
 * Compare two grayscale frames of the same size.
 * Returns the count and fraction of pixels that moved, plus the bounding box of
 * the movement in buffer coordinates (null when nothing moved) — the UI draws
 * that box on the preview so you can see WHAT tripped the alarm.
 */
export function frameDiff(prev, curr, width, height, pixelThreshold) {
  const total = width * height;
  if (!prev || !curr || prev.length !== curr.length || curr.length !== total) {
    return { changed: 0, total, ratio: 0, bbox: null };
  }
  let changed = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const d = curr[i] - prev[i];
      if ((d < 0 ? -d : d) > pixelThreshold) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    changed,
    total,
    ratio: total ? changed / total : 0,
    bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

export const STATE = {
  IDLE: 'idle',
  WARMUP: 'warmup',
  WATCHING: 'watching',
  ALARM: 'alarm',
  COOLDOWN: 'cooldown',
};

/**
 * The arm/alarm state machine. Time is always passed in (`now` in ms) rather
 * than read from the clock, so tests drive it deterministically.
 *
 *   idle ──arm()──> warmup ──warmupMs──> watching ──holdFrames over threshold──>
 *   alarm ──alarmMs or dismiss()──> cooldown ──cooldownMs──> watching
 *
 * `holdFrames` is what keeps a single compression-noise frame from screaming at
 * you at 3am: real motion persists across consecutive samples, codec noise does
 * not.
 */
export class MotionGate {
  constructor(opts = {}) {
    this.opts = {
      minAreaPct: 0.5,
      holdFrames: 2,
      warmupMs: 3000,
      cooldownMs: 8000,
      alarmMs: 4000,
      holdUntilDismissed: false,
      ...opts,
    };
    this.state = STATE.IDLE;
    this.streak = 0;
    this.until = 0; // deadline for the current timed state
    this.lastTriggerAt = 0;
    this.triggers = 0;
  }

  configure(patch = {}) {
    this.opts = { ...this.opts, ...patch };
    return this.opts;
  }

  arm(now) {
    this.state = this.opts.warmupMs > 0 ? STATE.WARMUP : STATE.WATCHING;
    this.until = now + this.opts.warmupMs;
    this.streak = 0;
    return this.state;
  }

  disarm() {
    this.state = STATE.IDLE;
    this.streak = 0;
    this.until = 0;
    return this.state;
  }

  /** Stop a sounding alarm early; the cooldown still applies. */
  dismiss(now) {
    if (this.state !== STATE.ALARM) return this.state;
    this.state = STATE.COOLDOWN;
    this.until = now + this.opts.cooldownMs;
    return this.state;
  }

  get armed() {
    return this.state !== STATE.IDLE;
  }

  get alarming() {
    return this.state === STATE.ALARM;
  }

  /**
   * Feed one sampled motion ratio. Returns a snapshot for the UI; `fired` is
   * true on exactly the tick the alarm starts, so the caller plays the sound
   * once rather than every frame.
   */
  update(ratio, now) {
    const o = this.opts;
    const over = ratio >= o.minAreaPct / 100;
    let fired = false;

    switch (this.state) {
      case STATE.IDLE:
        this.streak = 0;
        break;

      case STATE.WARMUP:
        if (now >= this.until) {
          this.state = STATE.WATCHING;
          this.streak = 0;
        }
        break;

      case STATE.WATCHING:
        this.streak = over ? this.streak + 1 : 0;
        if (this.streak >= o.holdFrames) {
          this.state = STATE.ALARM;
          this.until = o.holdUntilDismissed ? Infinity : now + o.alarmMs;
          this.lastTriggerAt = now;
          this.triggers++;
          this.streak = 0;
          fired = true;
        }
        break;

      case STATE.ALARM:
        if (now >= this.until) {
          this.state = STATE.COOLDOWN;
          this.until = now + o.cooldownMs;
        }
        break;

      case STATE.COOLDOWN:
        if (now >= this.until) {
          this.state = STATE.WATCHING;
          this.streak = 0;
        }
        break;
    }

    return {
      state: this.state,
      fired,
      armed: this.state !== STATE.IDLE,
      ratio,
      over,
      streak: this.streak,
      alarming: this.state === STATE.ALARM,
      // Milliseconds left in warmup/alarm/cooldown; 0 when the state is untimed.
      remainingMs:
        this.state === STATE.WARMUP || this.state === STATE.COOLDOWN || this.state === STATE.ALARM
          ? Math.max(0, this.until === Infinity ? 0 : this.until - now)
          : 0,
      triggers: this.triggers,
      lastTriggerAt: this.lastTriggerAt,
    };
  }
}

export default { sensitivityToParams, toGray, frameDiff, MotionGate, STATE };
