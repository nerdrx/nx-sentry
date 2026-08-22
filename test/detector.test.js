// Unit tests for the motion core. Everything here runs headless — the point of
// keeping detector.js free of DOM is that the maths can be pinned down without
// a compositor, a screen or a portal dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sensitivityToParams,
  boostFromSlider,
  sliderFromBoost,
  toGray,
  frameDiff,
  frameDiffRGBA,
  buildMask,
  MotionGate,
  STATE,
} from '../src/renderer/detector.js';

const gray = (w, h, fill = 0) => new Uint8Array(w * h).fill(fill);

test('sensitivity maps monotonically onto both thresholds', () => {
  const low = sensitivityToParams(0);
  const mid = sensitivityToParams(50);
  const high = sensitivityToParams(100);
  assert.ok(low.pixelThreshold > mid.pixelThreshold);
  assert.ok(mid.pixelThreshold > high.pixelThreshold);
  assert.ok(low.minAreaPct > mid.minAreaPct);
  assert.ok(mid.minAreaPct > high.minAreaPct);
  assert.equal(high.pixelThreshold, 8);
  // Out-of-range input is clamped, never NaN — the slider is user input.
  assert.deepEqual(sensitivityToParams(1e6), high);
  assert.deepEqual(sensitivityToParams('nonsense'), low);
});

test('toGray weights channels and reuses the output buffer', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  const out = new Uint8Array(3);
  const g = toGray(rgba, out);
  assert.equal(g, out, 'reuses the buffer it was handed');
  assert.equal(g[0], 255);
  assert.equal(g[1], 0);
  assert.ok(g[2] > 60 && g[2] < 90, `red luma ~76, got ${g[2]}`);
  // A wrongly-sized scratch buffer must not corrupt the result.
  assert.equal(toGray(rgba, new Uint8Array(99)).length, 3);
});

test('frameDiff counts only pixels past the threshold', () => {
  const a = gray(4, 4, 100);
  const b = gray(4, 4, 100);
  b[5] = 140; // +40
  b[6] = 110; // +10, below a threshold of 20
  const d = frameDiff(a, b, 4, 4, 20);
  assert.equal(d.changed, 1);
  assert.equal(d.total, 16);
  assert.ok(Math.abs(d.ratio - 1 / 16) < 1e-9);
  assert.deepEqual(d.bbox, { x: 1, y: 1, w: 1, h: 1 });
});

test('frameDiff bounding box spans every moving pixel', () => {
  const a = gray(10, 10, 0);
  const b = gray(10, 10, 0);
  b[2 * 10 + 3] = 255;
  b[7 * 10 + 8] = 255;
  const d = frameDiff(a, b, 10, 10, 20);
  assert.deepEqual(d.bbox, { x: 3, y: 2, w: 6, h: 6 });
});

test('frameDiff is safe on the first frame and on size changes', () => {
  const b = gray(4, 4, 10);
  assert.deepEqual(frameDiff(null, b, 4, 4, 20), { changed: 0, total: 16, ratio: 0, bbox: null });
  assert.equal(frameDiff(gray(2, 2), b, 4, 4, 20).ratio, 0);
});

test('gate: warmup swallows motion, then holdFrames gates the alarm', () => {
  const g = new MotionGate({ minAreaPct: 1, holdFrames: 2, warmupMs: 1000, alarmMs: 500, cooldownMs: 1000 });
  assert.equal(g.state, STATE.IDLE);
  assert.equal(g.update(0.5, 0).fired, false, 'idle ignores motion');

  g.arm(0);
  assert.equal(g.state, STATE.WARMUP);
  assert.equal(g.update(0.9, 200).fired, false, 'motion during warmup is the user walking away');
  assert.equal(g.update(0.9, 900).state, STATE.WARMUP);

  assert.equal(g.update(0.0, 1000).state, STATE.WATCHING);
  assert.equal(g.update(0.02, 1100).fired, false, 'one frame is not enough');
  const hit = g.update(0.02, 1200);
  assert.equal(hit.fired, true);
  assert.equal(hit.state, STATE.ALARM);
  assert.equal(hit.triggers, 1);
});

test('gate: a single noisy frame never fires', () => {
  const g = new MotionGate({ minAreaPct: 1, holdFrames: 3, warmupMs: 0 });
  g.arm(0);
  for (let i = 1; i <= 20; i++) {
    // motion, quiet, motion, quiet... a streak never reaches 3
    const r = g.update(i % 2 ? 0.5 : 0, i * 100);
    assert.equal(r.fired, false);
  }
});

test('gate: alarm expires into cooldown, cooldown re-arms', () => {
  const g = new MotionGate({ minAreaPct: 1, holdFrames: 1, warmupMs: 0, alarmMs: 500, cooldownMs: 1000 });
  g.arm(0);
  assert.equal(g.update(0.5, 100).fired, true);
  assert.equal(g.update(0.5, 300).state, STATE.ALARM, 'still sounding');
  assert.equal(g.update(0.5, 600).state, STATE.COOLDOWN);
  assert.equal(g.update(0.5, 900).fired, false, 'cooldown cannot re-fire');
  assert.equal(g.update(0, 1700).state, STATE.WATCHING);
  assert.equal(g.update(0.5, 1800).fired, true, 'and can fire again after that');
  assert.equal(g.triggers, 2);
});

test('gate: holdUntilDismissed keeps sounding until dismissed', () => {
  const g = new MotionGate({ minAreaPct: 1, holdFrames: 1, warmupMs: 0, alarmMs: 100, cooldownMs: 200, holdUntilDismissed: true });
  g.arm(0);
  g.update(0.5, 0);
  assert.equal(g.update(0, 60_000).state, STATE.ALARM, 'no timeout when held');
  assert.equal(g.update(0, 60_000).remainingMs, 0);
  g.dismiss(60_000);
  assert.equal(g.state, STATE.COOLDOWN);
  assert.equal(g.update(0, 60_300).state, STATE.WATCHING);
});

test('gate: disarm stops everything, including a sounding alarm', () => {
  const g = new MotionGate({ minAreaPct: 1, holdFrames: 1, warmupMs: 0 });
  g.arm(0);
  g.update(0.5, 0);
  assert.equal(g.alarming, true);
  g.disarm();
  assert.equal(g.armed, false);
  assert.equal(g.update(0.9, 100).fired, false);
});

test('gate: threshold is a percentage of the region, not a fraction', () => {
  const g = new MotionGate({ minAreaPct: 2, holdFrames: 1, warmupMs: 0 });
  g.arm(0);
  assert.equal(g.update(0.019, 10).over, false, '1.9% is under a 2% threshold');
  assert.equal(g.update(0.021, 20).over, true);
});

test('the snapshot reports armed so the UI can style the region', () => {
  const g = new MotionGate({ minAreaPct: 1, holdFrames: 1, warmupMs: 100 });
  assert.equal(g.update(0, 0).armed, false);
  g.arm(0);
  assert.equal(g.update(0, 10).armed, true, 'warmup counts as armed');
  assert.equal(g.update(0, 200).armed, true);
  assert.equal(g.update(0.5, 300).armed, true, 'and so does a sounding alarm');
  g.disarm();
  assert.equal(g.update(0.5, 400).armed, false);
});

// --------------------------------------------------------------------------
// The sensitivity multiplier and pixel-exact watching
// --------------------------------------------------------------------------

test('the multiplier divides both thresholds and bottoms out at "any change"', () => {
  const base = sensitivityToParams(55);
  const x10 = sensitivityToParams(55, 10);
  assert.ok(x10.pixelThreshold < base.pixelThreshold);
  assert.ok(Math.abs(x10.minAreaPct - base.minAreaPct / 10) < 1e-6);

  // At the top of the range a single unit of change in one channel counts, and
  // the area threshold is far below one pixel of any realistic region.
  const max = sensitivityToParams(100, 1000);
  assert.equal(max.pixelThreshold, 0);
  assert.ok(max.minAreaPct > 0, 'still a positive number, not rounded to zero');
  assert.ok(max.minAreaPct * 0.01 * 1_000_000 < 1, 'under one pixel of a 1MP region');

  // Out-of-range multipliers are clamped, never NaN.
  assert.deepEqual(sensitivityToParams(55, 0), base);
  assert.deepEqual(sensitivityToParams(55, 1e9), sensitivityToParams(55, 1000));
  assert.deepEqual(sensitivityToParams(55, 'x'), base);
});

test('the multiplier slider mapping round-trips', () => {
  assert.equal(boostFromSlider(0), 1);
  assert.equal(boostFromSlider(100), 1000);
  for (const v of [0, 17, 33, 50, 78, 100]) {
    assert.equal(sliderFromBoost(boostFromSlider(v)), v, `slider ${v}`);
  }
  assert.ok(boostFromSlider(50) > boostFromSlider(49), 'monotonic');
});

test('frameDiffRGBA sees a single pixel change that grayscale misses', () => {
  const w = 4, h = 4;
  const a = new Uint8ClampedArray(w * h * 4).fill(0);
  const b = new Uint8ClampedArray(w * h * 4).fill(0);
  // Two colours chosen to share a luma under BT.601 weights: only a channel
  // comparison can tell them apart.
  const i = 5 * 4;
  a[i] = 30; a[i + 1] = 30; a[i + 2] = 30;
  b[i] = 14; b[i + 1] = 44; b[i + 2] = 1;
  assert.equal(toGray(a, new Uint8Array(w * h))[5], toGray(b, new Uint8Array(w * h))[5],
    'the two colours are identical in grayscale');
  assert.equal(frameDiff(toGray(a, null), toGray(b, null), w, h, 0).changed, 0);

  const d = frameDiffRGBA(a, b, w, h, 0);
  assert.equal(d.changed, 1);
  assert.deepEqual(d.bbox, { x: 1, y: 1, w: 1, h: 1 });
  assert.equal(d.total, 16);
});

test('frameDiffRGBA with threshold 0 counts a one-unit change, and ignores alpha', () => {
  const w = 2, h = 1;
  const a = new Uint8ClampedArray([10, 10, 10, 255, 10, 10, 10, 255]);
  const b = new Uint8ClampedArray([11, 10, 10, 255, 10, 10, 10, 3]);
  const d = frameDiffRGBA(a, b, w, h, 0);
  assert.equal(d.changed, 1, 'the +1 red counts, the alpha drop does not');
  assert.equal(frameDiffRGBA(a, b, w, h, 1).changed, 0, 'threshold 1 needs more than one unit');
});

test('frameDiffRGBA is safe on the first frame and on size changes', () => {
  const b = new Uint8ClampedArray(16);
  assert.deepEqual(frameDiffRGBA(null, b, 2, 2, 0), { changed: 0, total: 4, ratio: 0, bbox: null });
  assert.equal(frameDiffRGBA(new Uint8ClampedArray(8), b, 2, 2, 0).ratio, 0);
});

test('gate: minChangedPixels is a floor under the area threshold', () => {
  const g = new MotionGate({ minAreaPct: 0.0001, minChangedPixels: 5, holdFrames: 1, warmupMs: 0 });
  g.arm(0);
  // 3 pixels of a 10000-pixel region clears the area threshold but not the floor.
  assert.equal(g.update({ ratio: 3 / 10000, changed: 3, total: 10000 }, 10).fired, false);
  assert.equal(g.update({ ratio: 5 / 10000, changed: 5, total: 10000 }, 20).fired, true);
});

test('gate: one changed pixel fires when the floor is 1', () => {
  const g = new MotionGate({ minAreaPct: 0.000006, minChangedPixels: 1, holdFrames: 1, warmupMs: 0 });
  g.arm(0);
  const r = g.update({ ratio: 1 / 2_000_000, changed: 1, total: 2_000_000 }, 10);
  assert.equal(r.fired, true, 'a single pixel of a 2MP region is enough');
});

test('gate: a bare ratio still works and skips the pixel floor', () => {
  const g = new MotionGate({ minAreaPct: 1, minChangedPixels: 500, holdFrames: 1, warmupMs: 0 });
  g.arm(0);
  assert.equal(g.update(0.02, 10).fired, true, 'no pixel count reported, no floor applied');
});

// --------------------------------------------------------------------------
// Ignored areas
// --------------------------------------------------------------------------

const FULL = { x: 0, y: 0, w: 1, h: 1 };

test('buildMask projects frame rectangles onto the analysis grid', () => {
  // The left half of the frame, on a 10×10 grid, is 50 cells.
  const m = buildMask(10, 10, FULL, [{ x: 0, y: 0, w: 0.5, h: 1 }]);
  assert.equal(m.ignored, 50);
  assert.equal(m.unmasked, 50);
  assert.equal(m.data[0], 1);
  assert.equal(m.data[9], 0, 'the right half is untouched');
});

test('buildMask is relative to the region, not the frame', () => {
  // Region is the right half; an ignore area covering the frame's right
  // quarter therefore covers the region's right HALF.
  const region = { x: 0.5, y: 0, w: 0.5, h: 1 };
  const m = buildMask(10, 10, region, [{ x: 0.75, y: 0, w: 0.25, h: 1 }]);
  assert.equal(m.ignored, 50);
  assert.equal(m.data[0], 0, 'the region\'s left half still counts');
  assert.equal(m.data[9], 1);
});

test('buildMask clips to the grid and never double-counts an overlap', () => {
  const m = buildMask(10, 10, FULL, [
    { x: -0.5, y: -0.5, w: 1, h: 1 }, // half outside the frame
    { x: 0, y: 0, w: 0.5, h: 0.5 }, // entirely inside the first
  ]);
  assert.equal(m.ignored, 25, 'the overlap is counted once');
  assert.equal(m.unmasked, 75);
});

test('buildMask returns null when there is nothing to ignore', () => {
  assert.equal(buildMask(10, 10, FULL, []), null);
  assert.equal(buildMask(10, 10, FULL, null), null);
  // A rectangle entirely outside the region masks nothing, so: still null.
  assert.equal(buildMask(10, 10, { x: 0, y: 0, w: 0.5, h: 1 }, [{ x: 0.8, y: 0, w: 0.1, h: 0.1 }]), null);
});

test('a masked pixel never counts as motion, in either diff', () => {
  const mask = buildMask(10, 10, FULL, [{ x: 0, y: 0, w: 0.5, h: 0.5 }]); // top-left quarter
  const a = gray(10, 10, 0);
  const b = gray(10, 10, 0);
  b[0] = 255; // inside the ignored area
  b[99] = 255; // outside it
  const d = frameDiff(a, b, 10, 10, 20, mask);
  assert.equal(d.changed, 1);
  assert.deepEqual(d.bbox, { x: 9, y: 9, w: 1, h: 1 }, 'the box ignores masked motion too');

  const ra = new Uint8ClampedArray(400);
  const rb = new Uint8ClampedArray(400);
  rb[0] = 9; // masked
  rb[396] = 9; // last pixel, unmasked
  assert.equal(frameDiffRGBA(ra, rb, 10, 10, 0, mask).changed, 1);
});

test('the ratio is a share of what is actually watched', () => {
  const mask = buildMask(10, 10, FULL, [{ x: 0, y: 0, w: 0.5, h: 1 }]); // half ignored
  const a = gray(10, 10, 0);
  const b = gray(10, 10, 0);
  b[9] = 255;
  const d = frameDiff(a, b, 10, 10, 20, mask);
  assert.equal(d.total, 50, 'the denominator drops the ignored pixels');
  assert.ok(Math.abs(d.ratio - 1 / 50) < 1e-9, 'not 1/100 — that would understate it');
});
