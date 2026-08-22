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
 * Map the user-facing sensitivity slider (0..100) and its multiplier onto the
 * two knobs the detector actually has. Both move together on purpose: a
 * sensitive setting should notice both fainter changes (lower luma threshold)
 * and smaller ones (lower area threshold).
 *
 * 0   → luma must move 48/255 across 2.5% of the region (a person walking past)
 * 100 → luma must move 8/255 across 0.06% of the region (a cursor twitch)
 *
 * The slider alone bottoms out at "a cursor twitch", which is nowhere near the
 * floor of what the hardware can see. `boost` divides both thresholds, so ×1000
 * takes them to "any change at all, anywhere" — a threshold of 0 means a delta
 * of a single unit counts, and the area threshold falls below one pixel of any
 * realistic region. Guard the bottom end with `minChangedPixels` on the gate.
 */
export function sensitivityToParams(sensitivity, boost = 1) {
  const s = clamp(Number(sensitivity) || 0, 0, 100) / 100;
  const b = clamp(Number(boost) || 1, 1, 1000);
  const pixelThreshold = Math.max(0, Math.round((48 - 40 * s) / b));
  // Geometric, not linear: the interesting range is all down at the small end,
  // and a linear slider would spend 90% of its travel between "huge" and "big".
  const minAreaPct = (2.5 * Math.pow(0.06 / 2.5, s)) / b;
  return {
    pixelThreshold,
    // Six decimals so a big boost stays representable: 0.06% / 1000 is
    // 0.00006%, which rounds to zero at four.
    minAreaPct: Number(minAreaPct.toFixed(6)),
  };
}

/** Slider position (0..100) ↔ multiplier (×1..×1000), geometric in both directions. */
export function boostFromSlider(v) {
  const n = clamp(Number(v) || 0, 0, 100);
  const boost = Math.pow(10, (n / 100) * 3);
  return Number(boost < 10 ? boost.toFixed(1) : boost.toFixed(0));
}
export function sliderFromBoost(boost) {
  const b = clamp(Number(boost) || 1, 1, 1000);
  return Math.round((Math.log10(b) / 3) * 100);
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
export function frameDiff(prev, curr, width, height, pixelThreshold, mask = null) {
  const size = width * height;
  const total = mask ? mask.unmasked : size;
  if (!prev || !curr || prev.length !== curr.length || curr.length !== size) {
    return { changed: 0, total, ratio: 0, bbox: null };
  }
  const skip = mask?.data ?? null;
  let changed = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      if (skip && skip[i]) continue;
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

/**
 * Compare two RGBA frames channel by channel — the pixel-exact path.
 *
 * Grayscale is lossy: BT.601 maps different colours onto the same luma, so a
 * pixel that flips from one colour to another of equal brightness is invisible
 * to frameDiff. When the question is "did this pixel change at all", the answer
 * has to come from the channels themselves. A threshold of 0 means any
 * difference of one unit in any channel counts. Alpha is ignored — a capture
 * stream is opaque, and a compositor writing 254 there is not motion.
 */
export function frameDiffRGBA(prev, curr, width, height, threshold = 0, mask = null) {
  const size = width * height;
  const total = mask ? mask.unmasked : size;
  if (!prev || !curr || prev.length !== curr.length || curr.length !== size * 4) {
    return { changed: 0, total, ratio: 0, bbox: null };
  }
  const skip = mask?.data ?? null;
  let changed = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0, j = 0; i < size; i++, j += 4) {
    if (skip && skip[i]) continue;
    const dr = curr[j] - prev[j];
    const dg = curr[j + 1] - prev[j + 1];
    const db = curr[j + 2] - prev[j + 2];
    const d = Math.max(dr < 0 ? -dr : dr, dg < 0 ? -dg : dg, db < 0 ? -db : db);
    if (d > threshold) {
      changed++;
      const x = i % width;
      const y = (i - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    changed,
    total,
    ratio: total ? changed / total : 0,
    bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

/**
 * Build the ignore mask for one analysis buffer.
 *
 * Ignore areas are stored in FRAME coordinates, not region coordinates, so they
 * stay pinned to the thing they cover — a timestamp burnt into a camera image,
 * a clock, a tree in the corner of the garden — while the watched rectangle is
 * moved or resized around them. Here they are projected into the analysis
 * buffer's grid and clipped to it.
 *
 * Returns null when nothing is masked, so the diff loops keep their fast path,
 * and `{ data, unmasked, ignored }` otherwise. `unmasked` becomes the diff's
 * denominator: a percentage of an area you have declared irrelevant is a lie.
 */
export function buildMask(width, height, region, exclusions) {
  if (!Array.isArray(exclusions) || !exclusions.length || !region) return null;
  if (!(width > 0) || !(height > 0)) return null;
  const data = new Uint8Array(width * height);
  let ignored = 0;
  for (const e of exclusions) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    // frame → region → analysis grid
    const x0 = Math.floor(((e.x - region.x) / region.w) * width);
    const y0 = Math.floor(((e.y - region.y) / region.h) * height);
    const x1 = Math.ceil(((e.x + e.w - region.x) / region.w) * width);
    const y1 = Math.ceil(((e.y + e.h - region.y) / region.h) * height);
    const left = clamp(x0, 0, width), right = clamp(x1, 0, width);
    const top = clamp(y0, 0, height), bottom = clamp(y1, 0, height);
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = y * width + x;
        if (!data[i]) {
          data[i] = 1;
          ignored++; // counted once, so overlapping areas cannot double-count
        }
      }
    }
  }
  if (!ignored) return null;
  return { data, unmasked: width * height - ignored, ignored };
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
      // An absolute floor in pixels, ANDed with the area threshold. At 1 it is
      // a no-op (any single changed pixel may pass); above that it is what
      // stops a boosted, pixel-exact setup from firing on one stray pixel of
      // video noise. It only applies when the caller reports pixel counts.
      minChangedPixels: 1,
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
   * Feed one sample. Accepts either a bare motion ratio or the whole diff
   * result ({ ratio, changed, total }); the latter is what lets
   * `minChangedPixels` apply, since a percentage alone cannot say how many
   * pixels it stands for. Returns a snapshot for the UI; `fired` is true on
   * exactly the tick the alarm starts, so the caller plays the sound once
   * rather than every frame.
   */
  update(sample, now) {
    const o = this.opts;
    const ratio = typeof sample === 'number' ? sample : (sample?.ratio ?? 0);
    const changed = typeof sample === 'number' ? null : sample?.changed ?? null;
    const over =
      ratio >= o.minAreaPct / 100 &&
      (changed === null || changed >= Math.max(1, o.minChangedPixels));
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

export default {
  sensitivityToParams,
  boostFromSlider,
  sliderFromBoost,
  toGray,
  frameDiff,
  frameDiffRGBA,
  buildMask,
  MotionGate,
  STATE,
};
