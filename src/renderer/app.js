// src/renderer/app.js — the UI and the sampling loop. The maths lives in
// detector.js (unit-tested headless), the noise in alarm.js, the pixels in
// capture.js; this file wires them to the DOM and to the settings file.

import { sensitivityToParams, toGray, frameDiff, MotionGate, STATE } from './detector.js';
import { Alarm } from './alarm.js';
import { startCapture, startMock } from './capture.js';

const $ = (id) => document.getElementById(id);

// 0.3214 → "0.32", 2.5 → "2.5". Percentages in the UI never carry more digits
// than the eye can use.
const pct = (v) => (v >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, '');

// Without the preload bridge (renderer opened directly in a browser for UI
// work) everything still runs — settings just live for the session.
const api = window.sentry || {
  info: async () => ({ version: 'dev', mock: true, platform: 'web', wayland: false }),
  settings: (() => {
    let s = null;
    return {
      get: async () => (s ??= {}),
      set: async (patch) => (s = { ...(s || {}), ...patch }),
    };
  })(),
  sources: { list: async () => [], select: async () => null },
  setState: async () => {},
  alert: async () => {},
  hideWindow: async () => {},
  onCommand: () => () => {},
};

const gate = new MotionGate();
const alarm = new Alarm();

let settings = null;
let info = { version: '', mock: false };
let stream = null;
let sampleTimer = null;
let params = { pixelThreshold: 24, minAreaPct: 0.35 };

// analysis scratch — allocated once per region size, never per frame
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
let bufA = null, bufB = null, useA = true, prevGray = null;
let blobTimer = null;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let saveTimer = null;
function patch(p, { immediate = false } = {}) {
  settings = { ...settings, ...p };
  applySettings();
  if (immediate) {
    api.settings.set(p);
    return;
  }
  // Sliders fire continuously; write once the user pauses.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.settings.set(p), 200);
}

function applySettings() {
  params = sensitivityToParams(settings.sensitivity);
  gate.configure({
    minAreaPct: params.minAreaPct,
    holdFrames: settings.holdFrames,
    warmupMs: settings.warmupMs,
    cooldownMs: settings.cooldownMs,
    alarmMs: settings.alarmMs,
    holdUntilDismissed: settings.holdUntilDismissed,
  });
  alarm.setVolume(settings.alarmVolume);
  restartSampling();
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function useStream(next) {
  stopStream();
  stream = next;
  const video = $('video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  $('scrim').classList.add('hidden');
  $('region').hidden = false;
  $('btnArm').disabled = false;
  prevGray = null;

  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => {
    // The portal was revoked, or the shared window closed. Stop pretending to
    // watch: an armed sentry with a dead stream is worse than no sentry.
    toast('The screen share ended, so watching stopped.', 'error');
    disarm();
    stopStream();
    $('scrim').classList.remove('hidden');
    $('region').hidden = true;
    $('btnArm').disabled = true;
    $('sourceName').textContent = 'No source';
    setChip('idle', 'Idle');
  });

  const sizeStage = () => {
    if (video.videoWidth) $('stage').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    layoutRegion();
  };
  video.addEventListener('loadedmetadata', sizeStage);
  sizeStage();
  restartSampling();
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function restartSampling() {
  clearInterval(sampleTimer);
  if (!stream) return;
  sampleTimer = setInterval(sample, Math.round(1000 / (settings?.analyzeFps || 8)));
}

function sample() {
  const video = $('video');
  if (!video.videoWidth) return;
  const r = settings.region;
  const vw = video.videoWidth, vh = video.videoHeight;
  const sx = Math.round(r.x * vw), sy = Math.round(r.y * vh);
  const sw = Math.max(2, Math.round(r.w * vw)), sh = Math.max(2, Math.round(r.h * vh));

  // Analyse a thumbnail of the region, not the region: 192px on the long edge
  // is plenty to see a person move and costs a fraction of a millisecond.
  const scale = Math.min(1, 192 / Math.max(sw, sh));
  const aw = Math.max(8, Math.round(sw * scale));
  const ah = Math.max(8, Math.round(sh * scale));
  if (work.width !== aw || work.height !== ah) {
    work.width = aw;
    work.height = ah;
    bufA = new Uint8Array(aw * ah);
    bufB = new Uint8Array(aw * ah);
    prevGray = null; // the old baseline describes a different rectangle
  }

  let data;
  try {
    wctx.drawImage(video, sx, sy, sw, sh, 0, 0, aw, ah);
    data = wctx.getImageData(0, 0, aw, ah).data;
  } catch {
    return; // a frame between resolution changes; the next one will be fine
  }

  const curr = toGray(data, useA ? bufA : bufB);
  const diff = frameDiff(prevGray, curr, aw, ah, params.pixelThreshold);
  prevGray = curr;
  useA = !useA;

  const snap = gate.update(diff.ratio, performance.now());
  paint(snap, diff, { aw, ah });
  if (snap.fired) onMotion(snap, diff);
}

// ---------------------------------------------------------------------------
// Arm / alarm
// ---------------------------------------------------------------------------

function arm() {
  if (!stream) return;
  alarm.ensure(); // this click is the gesture that unlocks audio
  prevGray = null;
  gate.arm(performance.now());
  api.setState({ armed: true, alarming: false });
  paint(gate.update(0, performance.now()), { ratio: 0, bbox: null }, null);
}

function disarm() {
  gate.disarm();
  alarm.stop();
  hideBanner();
  api.setState({ armed: false, alarming: false });
  paint(gate.update(0, performance.now()), { ratio: 0, bbox: null }, null);
}

function dismiss() {
  gate.dismiss(performance.now());
  alarm.stop();
  hideBanner();
  api.setState({ armed: gate.armed, alarming: false });
}

function onMotion(snap, diff) {
  alarm.start(settings.alarmSound, {
    volume: settings.alarmVolume,
    durationMs: settings.alarmMs,
    hold: settings.holdUntilDismissed,
  });
  api.setState({ armed: true, alarming: true });
  const pct = (diff.ratio * 100).toFixed(2);
  api.alert({ title: 'Motion detected', body: `${pct}% of the watched area changed.`, show: false });
  logEvent(new Date(), diff.ratio);
  showBanner(new Date(), diff.ratio);
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

const LABEL = {
  [STATE.IDLE]: 'Idle',
  [STATE.WARMUP]: 'Getting ready',
  [STATE.WATCHING]: 'Watching',
  [STATE.ALARM]: 'Motion detected',
  [STATE.COOLDOWN]: 'Quiet time',
};

function setChip(state, text) {
  const chip = $('stateChip');
  chip.dataset.state = state;
  $('stateChipText').textContent = text;
}

function paint(snap, diff, dims) {
  const state = snap.state;
  setChip(state, LABEL[state]);
  $('stateBig').textContent = LABEL[state];
  $('btnArm').textContent = snap.state === STATE.IDLE ? 'Start watching' : 'Stop watching';

  const secs = Math.ceil(snap.remainingMs / 1000);
  $('stateDetail').textContent =
    state === STATE.WARMUP ? `${secs}s grace`
    : state === STATE.COOLDOWN ? `${secs}s until it watches again`
    : state === STATE.ALARM ? (settings.holdUntilDismissed ? 'press Esc to silence' : `${secs}s left`)
    : state === STATE.WATCHING ? `${snap.triggers} trigger${snap.triggers === 1 ? '' : 's'} so far`
    : '';

  // Meter: the trip line sits at a third of the trough, so a ratio three times
  // the threshold fills it. Absolute percentages are in the legend.
  const trip = params.minAreaPct / 100;
  const shown = Math.min(1, diff.ratio / (trip * 3 || 1));
  $('meterFill').style.width = `${(shown * 100).toFixed(1)}%`;
  $('meterTick').style.left = '33.3%';
  $('meterNow').textContent = `${(diff.ratio * 100).toFixed(2)}% moving`;
  $('meterTrip').textContent = `trips at ${pct(params.minAreaPct)}%`;

  const region = $('region');
  region.classList.toggle('armed', snap.armed && !snap.alarming);
  region.classList.toggle('hit', snap.alarming);

  if (dims && diff.bbox && snap.armed) showBlob(diff.bbox, dims);
  if (state !== STATE.ALARM) {
    if (alarm.playing) alarm.stop();
    hideBanner();
  }
}

function showBlob(bbox, { aw, ah }) {
  const blob = $('blob');
  blob.hidden = false;
  blob.style.opacity = '1';
  blob.style.left = `${(bbox.x / aw) * 100}%`;
  blob.style.top = `${(bbox.y / ah) * 100}%`;
  blob.style.width = `${(bbox.w / aw) * 100}%`;
  blob.style.height = `${(bbox.h / ah) * 100}%`;
  clearTimeout(blobTimer);
  blobTimer = setTimeout(() => (blob.style.opacity = '0'), 400);
}

const two = (n) => String(n).padStart(2, '0');
// Locale-independent on purpose (DESIGN §7): host machines run any locale and
// a log that changes shape with LANG is a log nobody can grep.
const hhmmss = (d) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

function logEvent(date, ratio) {
  const log = $('log');
  log.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = hhmmss(date);
  const what = document.createElement('span');
  what.textContent = 'motion in the watched area';
  const d = document.createElement('span');
  d.className = 'd';
  d.textContent = `${(ratio * 100).toFixed(2)}%`;
  li.append(t, what, d);
  log.prepend(li);
  while (log.children.length > 50) log.lastElementChild.remove();
}

let banner = null;
function showBanner(date, ratio) {
  hideBanner();
  banner = document.createElement('div');
  banner.className = 'banner';
  const txt = document.createElement('div');
  txt.className = 'txt';
  const b = document.createElement('b');
  b.textContent = 'Motion detected';
  const s = document.createElement('span');
  s.textContent = `${hhmmss(date)} · ${(ratio * 100).toFixed(2)}% of the area changed`;
  txt.append(b, s);
  const stop = document.createElement('button');
  stop.className = 'amber';
  stop.textContent = 'Silence';
  stop.onclick = dismiss;
  banner.append(txt, stop);
  document.body.append(banner);
}
function hideBanner() {
  banner?.remove();
  banner = null;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4500);
}

// ---------------------------------------------------------------------------
// The region rectangle
// ---------------------------------------------------------------------------

function layoutRegion() {
  const r = settings.region;
  const el = $('region');
  el.style.left = `${r.x * 100}%`;
  el.style.top = `${r.y * 100}%`;
  el.style.width = `${r.w * 100}%`;
  el.style.height = `${r.h * 100}%`;
  const v = $('video');
  const px = v.videoWidth
    ? `${Math.round(r.w * v.videoWidth)}×${Math.round(r.h * v.videoHeight)} px`
    : `${Math.round(r.w * 100)}% × ${Math.round(r.h * 100)}%`;
  $('regionTag').textContent = px;
}

function setupRegionEditing() {
  const stage = $('stage');
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const MIN = 0.02;
  let drag = null;

  const pointAt = (e) => {
    const b = stage.getBoundingClientRect();
    return { x: clamp01((e.clientX - b.left) / b.width), y: clamp01((e.clientY - b.top) / b.height) };
  };

  stage.addEventListener('pointerdown', (e) => {
    if (!stream) return;
    const grip = e.target.closest?.('.grip');
    const inRegion = e.target.closest?.('.region');
    const p = pointAt(e);
    drag = {
      mode: grip ? grip.dataset.dir : inRegion ? 'move' : 'new',
      from: p,
      start: { ...settings.region },
    };
    if (drag.mode === 'new') {
      settings.region = { x: p.x, y: p.y, w: MIN, h: MIN };
      layoutRegion();
    }
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pointAt(e);
    const s = drag.start;
    let r;
    if (drag.mode === 'new') {
      r = { x: Math.min(drag.from.x, p.x), y: Math.min(drag.from.y, p.y), w: Math.abs(p.x - drag.from.x), h: Math.abs(p.y - drag.from.y) };
    } else if (drag.mode === 'move') {
      const dx = p.x - drag.from.x, dy = p.y - drag.from.y;
      r = { x: clamp01(Math.min(s.x + dx, 1 - s.w)), y: clamp01(Math.min(s.y + dy, 1 - s.h)), w: s.w, h: s.h };
    } else {
      const left = drag.mode.includes('w') ? p.x : s.x;
      const right = drag.mode.includes('e') ? p.x : s.x + s.w;
      const top = drag.mode.includes('n') ? p.y : s.y;
      const bottom = drag.mode.includes('s') ? p.y : s.y + s.h;
      r = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.abs(right - left), h: Math.abs(bottom - top) };
    }
    r.w = Math.max(MIN, Math.min(r.w, 1 - r.x));
    r.h = Math.max(MIN, Math.min(r.h, 1 - r.y));
    settings.region = r;
    prevGray = null; // the baseline belongs to the old rectangle
    layoutRegion();
  });

  const end = () => {
    if (!drag) return;
    drag = null;
    patch({ region: settings.region }, { immediate: true });
    layoutRegion();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------------------
// Source picker
// ---------------------------------------------------------------------------

async function pickSource() {
  if (info.mock) {
    await useStream(startMock());
    $('sourceName').textContent = 'Mock desktop (NX_SENTRY_MOCK=1)';
    return;
  }
  let sources = [];
  try {
    sources = await api.sources.list();
  } catch (err) {
    toast(`Could not list screens — ${err.message}`, 'error');
    return;
  }
  if (sources.length === 1) return void takeSource(sources[0]);
  if (!sources.length) {
    toast('No screens or windows were offered by the desktop portal.', 'error');
    return;
  }

  const scrim = document.createElement('div');
  scrim.className = 'scrim-full';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const h = document.createElement('h2');
  h.textContent = 'Choose what to watch';
  const grid = document.createElement('div');
  grid.className = 'sources';
  for (const s of sources) {
    const btn = document.createElement('button');
    btn.className = 'source';
    if (s.thumbnail) {
      const img = document.createElement('img');
      img.src = s.thumbnail;
      btn.append(img);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = s.name;
    const kd = document.createElement('div');
    kd.className = 'kd';
    kd.textContent = s.kind;
    meta.append(nm, kd);
    btn.append(meta);
    btn.onclick = () => {
      scrim.remove();
      takeSource(s);
    };
    grid.append(btn);
  }
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = 'On Wayland your desktop will ask again which screen to share — that dialog is the one that counts.';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = () => scrim.remove();
  sheet.append(h, grid, note, cancel);
  scrim.append(sheet);
  scrim.onclick = (e) => {
    if (e.target === scrim) scrim.remove();
  };
  document.body.append(scrim);
}

async function takeSource(source) {
  try {
    await useStream(await startCapture(source.id, api));
    $('sourceName').textContent = source.name;
  } catch (err) {
    // The portal dialog was dismissed, or the compositor refused.
    toast(`Screen capture was not granted — ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function bindControls() {
  const s = settings;

  const slider = (id, valId, key, format, mapIn = (v) => v, mapOut = (v) => v) => {
    const el = $(id);
    el.value = mapIn(s[key]);
    $(valId).textContent = format(s[key]);
    el.addEventListener('input', () => {
      const v = mapOut(Number(el.value));
      $(valId).textContent = format(v);
      patch({ [key]: v });
      if (key === 'sensitivity') showSensHint();
    });
  };

  slider('sens', 'sensVal', 'sensitivity', (v) => String(v));
  slider('hold', 'holdVal', 'holdFrames', (v) => String(v));
  slider('warm', 'warmVal', 'warmupMs', (v) => `${Math.round(v / 1000)}s`, (v) => v / 1000, (v) => v * 1000);
  slider('cool', 'coolVal', 'cooldownMs', (v) => `${Math.round(v / 1000)}s`, (v) => v / 1000, (v) => v * 1000);
  slider('fps', 'fpsVal', 'analyzeFps', (v) => String(v));
  slider('vol', 'volVal', 'alarmVolume', (v) => `${Math.round(v * 100)}%`, (v) => v * 100, (v) => v / 100);
  slider('len', 'lenVal', 'alarmMs', (v) => `${Math.round(v / 1000)}s`, (v) => v / 1000, (v) => v * 1000);

  const toggle = (id, key, after) => {
    const el = $(id);
    el.checked = !!s[key];
    el.addEventListener('change', () => {
      patch({ [key]: el.checked }, { immediate: true });
      after?.(el.checked);
    });
  };
  toggle('tHold', 'holdUntilDismissed', (on) => ($('alarmMsField').style.opacity = on ? '0.4' : '1'));
  toggle('tNotify', 'notify');
  toggle('tFlash', 'flashWindow');
  toggle('tTray', 'minimizeToTray');
  $('alarmMsField').style.opacity = s.holdUntilDismissed ? '0.4' : '1';

  for (const btn of $('sounds').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.sound === s.alarmSound));
    btn.addEventListener('click', () => {
      patch({ alarmSound: btn.dataset.sound }, { immediate: true });
      for (const b of $('sounds').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
      alarm.test(btn.dataset.sound, settings.alarmVolume);
    });
  }

  $('btnTest').addEventListener('click', () => alarm.test(settings.alarmSound, settings.alarmVolume));
  $('btnSource').addEventListener('click', pickSource);
  $('btnSourceEmpty').addEventListener('click', pickSource);
  $('btnTray').addEventListener('click', () => api.hideWindow());
  $('btnArm').addEventListener('click', () => (gate.armed ? disarm() : arm()));
  $('btnWhole').addEventListener('click', () => {
    patch({ region: { x: 0, y: 0, w: 1, h: 1 } }, { immediate: true });
    prevGray = null;
    layoutRegion();
  });
  $('btnCentre').addEventListener('click', () => {
    patch({ region: { x: 1 / 3, y: 1 / 3, w: 1 / 3, h: 1 / 3 } }, { immediate: true });
    prevGray = null;
    layoutRegion();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && gate.alarming) dismiss();
    if (e.code === 'Space' && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      gate.armed ? disarm() : arm();
    }
  });

  api.onCommand((cmd) => {
    if (cmd === 'arm') arm();
    else if (cmd === 'disarm') disarm();
    else if (cmd === 'dismiss') dismiss();
  });
}

function showSensHint() {
  $('sensHint').textContent =
    `Fires when at least ${pct(params.minAreaPct)}% of the area changes by more than ` +
    `${params.pixelThreshold} of 255 in brightness. Lower it if your own cursor keeps tripping it.`;
}

// One rAF-throttled pointer listener drives every card's sheen (DESIGN §5:
// light rides motion — the highlight tracks the cursor, it never sweeps once).
function bindSheen() {
  let pending = null;
  let scheduled = false;
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.card');
    if (!card) return;
    pending = { card, x: e.clientX, y: e.clientY };
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!pending) return;
      const { card: c, x, y } = pending;
      const b = c.getBoundingClientRect();
      c.style.setProperty('--mx', ((x - b.left) / b.width).toFixed(3));
      c.style.setProperty('--my', ((y - b.top) / b.height).toFixed(3));
      pending = null;
    });
  });
}

// ---------------------------------------------------------------------------

async function boot() {
  info = await api.info();
  settings = await api.settings.get();
  document.title = `NX Sentry ${info.version}`;
  $('barSub').textContent = info.mock
    ? 'Mock desktop — synthetic capture for testing'
    : 'Watching a rectangle of your screen';
  applySettings();
  bindControls();
  setupRegionEditing();
  bindSheen();
  layoutRegion();
  showSensHint();
  paint(gate.update(0, performance.now()), { ratio: 0, bbox: null }, null);

  alarm.onError = (err) => toast(`The alarm could not play — ${err.message}`, 'error');
  if (info.mock) {
    // Headless runs go straight to the fake desktop, and NX_SENTRY_AUTOARM=1
    // additionally arms the sentry so a screenshot can show the live states.
    await pickSource();
    if (info.autoArm) arm();
  }
}

boot();
