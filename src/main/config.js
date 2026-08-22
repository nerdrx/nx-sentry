// src/main/config.js — the one resolver for NX Sentry's config directory and
// the one place that knows the settings shape. Pure Node (no electron import)
// so the unit tests can exercise it headless.
//
// The directory is read AT CALL TIME from $NX_SENTRY_CONFIG_DIR, never captured
// at import: tests point it at a scratch dir per case, and a value frozen at
// module load would let a test write into the real installed app's settings.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Settings shape + defaults. Anything not listed here is dropped on load. */
export const DEFAULTS = {
  // region of the captured screen to watch, normalised 0..1 of the frame
  region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  sensitivity: 55, // 0..100 slider; maps to pixel + area thresholds
  holdFrames: 2, // consecutive moving frames before the alarm fires
  warmupMs: 3000, // grace period after arming (walk away from the mouse)
  cooldownMs: 8000, // silence after an alarm before it can fire again
  alarmSound: 'siren', // siren | beep | pulse | chime
  alarmVolume: 0.6, // 0..1
  alarmMs: 4000, // how long one alarm lasts when it is not held
  holdUntilDismissed: false, // true = keep sounding until the user stops it
  notify: true, // also raise a desktop notification
  flashWindow: true, // bounce the taskbar entry / show the window
  minimizeToTray: true,
  analyzeFps: 8, // frames per second sampled from the capture
};

/** The config directory: $NX_SENTRY_CONFIG_DIR if set, else ~/.config/nx-sentry. */
export function configDir() {
  const override = process.env.NX_SENTRY_CONFIG_DIR;
  // A set-but-empty variable is an accident in a launcher script; ignore it.
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(homedir(), '.config', 'nx-sentry');
}

export function configPath() {
  return join(configDir(), 'settings.json');
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Coerce anything (old file, hand edit, hostile IPC) into a valid settings object. */
export function sanitize(patch, base = DEFAULTS) {
  const s = { ...base };
  const p = patch && typeof patch === 'object' ? patch : {};

  if (p.region && typeof p.region === 'object') {
    const n = (v, d) => (Number.isFinite(v) ? clamp(v, 0, 1) : d);
    const x = n(p.region.x, base.region.x);
    const y = n(p.region.y, base.region.y);
    // A zero-size region would watch nothing and read as a broken app; keep a
    // floor of 1% of the frame and clip the box inside the frame.
    const w = clamp(n(p.region.w, base.region.w), 0.01, 1 - x);
    const h = clamp(n(p.region.h, base.region.h), 0.01, 1 - y);
    s.region = { x, y, w, h };
  }
  const num = (key, lo, hi) => {
    if (Number.isFinite(p[key])) s[key] = clamp(p[key], lo, hi);
  };
  num('sensitivity', 0, 100);
  num('holdFrames', 1, 30);
  num('warmupMs', 0, 60000);
  num('cooldownMs', 0, 600000);
  num('alarmVolume', 0, 1);
  num('alarmMs', 500, 120000);
  num('analyzeFps', 1, 30);
  if (['siren', 'beep', 'pulse', 'chime'].includes(p.alarmSound)) s.alarmSound = p.alarmSound;
  for (const key of ['holdUntilDismissed', 'notify', 'flashWindow', 'minimizeToTray']) {
    if (typeof p[key] === 'boolean') s[key] = p[key];
  }
  return s;
}

export function load() {
  try {
    return sanitize(JSON.parse(readFileSync(configPath(), 'utf8')));
  } catch {
    return { ...DEFAULTS }; // missing or corrupt file: defaults, never a crash
  }
}

/** Merge a patch into the stored settings and write it atomically. Returns the result. */
export function save(patch) {
  const next = sanitize(patch, load());
  mkdirSync(configDir(), { recursive: true });
  // Write-then-rename: a crash mid-write must not leave a half-parsed file that
  // resets every setting the next time the app starts.
  const tmp = configPath() + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, configPath());
  return next;
}

export default { DEFAULTS, configDir, configPath, sanitize, load, save };
