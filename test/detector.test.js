// Unit tests for the motion core. Everything here runs headless — the point of
// keeping detector.js free of DOM is that the maths can be pinned down without
// a compositor, a screen or a portal dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sensitivityToParams,
  toGray,
  frameDiff,
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
