// Settings persistence. Every case runs against a scratch config dir — the app
// under test must never be able to read or rewrite the real installed copy's
// settings.json.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, sanitize, load, save, configDir, configPath } from '../src/main/config.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nx-sentry-test-'));
  process.env.NX_SENTRY_CONFIG_DIR = dir;
});
after(() => {
  delete process.env.NX_SENTRY_CONFIG_DIR;
});

test('the config dir override is read at call time', () => {
  assert.equal(configDir(), dir);
  process.env.NX_SENTRY_CONFIG_DIR = '   ';
  assert.ok(configDir().endsWith('/.config/nx-sentry'), 'a blank override falls back home');
  process.env.NX_SENTRY_CONFIG_DIR = dir;
});

test('sanitize clamps numbers and drops unknown keys', () => {
  const s = sanitize({ sensitivity: 999, alarmVolume: -3, holdFrames: 0, junk: 'x', alarmSound: 'airhorn' });
  assert.equal(s.sensitivity, 100);
  assert.equal(s.alarmVolume, 0);
  assert.equal(s.holdFrames, 1);
  assert.equal(s.alarmSound, DEFAULTS.alarmSound, 'unknown sound falls back');
  assert.ok(!('junk' in s));
});

test('sanitize keeps the region inside the frame and never zero-sized', () => {
  const s = sanitize({ region: { x: 0.8, y: 0.9, w: 5, h: 5 } });
  assert.ok(s.region.x + s.region.w <= 1 + 1e-9);
  assert.ok(s.region.y + s.region.h <= 1 + 1e-9);
  assert.ok(s.region.w >= 0.01 && s.region.h >= 0.01);
  assert.deepEqual(sanitize({ region: { w: 0 } }).region.w, 0.01);
});

test('save merges into the stored file and load round-trips', () => {
  save({ sensitivity: 80 });
  save({ alarmSound: 'chime' });
  const s = load();
  assert.equal(s.sensitivity, 80, 'the second save did not reset the first');
  assert.equal(s.alarmSound, 'chime');
  assert.deepEqual(JSON.parse(readFileSync(configPath(), 'utf8')).sensitivity, 80);
});

test('a corrupt settings file falls back to defaults instead of crashing', () => {
  writeFileSync(configPath(), '{ not json');
  assert.deepEqual(load(), DEFAULTS);
  save({ sensitivity: 12 });
  assert.equal(load().sensitivity, 12, 'and the next save repairs the file');
});

test('no temp file is left behind after a save', () => {
  save({ sensitivity: 30 });
  assert.throws(() => readFileSync(configPath() + '.tmp'));
  rmSync(dir, { recursive: true, force: true });
});
