// src/renderer/app.js — the UI and the sampling loop. The maths lives in
// detector.js (unit-tested headless), the noise in alarm.js, the pixels in
// capture.js; this file wires them to the DOM and to the settings file.

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
} from './detector.js';
import { Alarm } from './alarm.js';
import { startCapture, startMock, listCameras, startCamera } from './capture.js';

const $ = (id) => document.getElementById(id);

// 0.3214 → "0.32", 2.5 → "2.5". Percentages in the UI never carry more digits
// than the eye can use — except at the bottom of the multiplier's range, where
// two decimals would round a real threshold down to a flat "0%" and claim the
// sentry fires on nothing at all.
const pct = (v) => {
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 0.01) return String(Number(v.toPrecision(2)));
  return (v >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, '');
};

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
let prevRGBA = null; // pixel-exact baseline: the previous frame's raw channels
let hasExactBaseline = false;
let blobTimer = null;
let lastAnalysis = { aw: 0, ah: 0, sw: 0, sh: 0, exact: false, capped: false };
let sampleCostMs = 0; // EMA of what one sample costs, in ms
let mask = null;      // ignore-area mask for the current analysis grid
let maskKey = '';     // what that mask was built from

// Pixel-exact analysis reads and diffs every pixel of the region, so the cost
// is linear in its area. Past this many pixels a sample would not finish inside
// a frame interval, so the region is scaled down and the UI says so rather than
// quietly promising an exactness it is not delivering.
const EXACT_MAX_PIXELS = 4_000_000;

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
  params = sensitivityToParams(settings.sensitivity, settings.sensitivityBoost);
  gate.configure({
    minAreaPct: params.minAreaPct,
    minChangedPixels: settings.minChangedPixels,
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

async function useStream(next, { kind = 'screen' } = {}) {
  stopStream();
  stream = next;
  const video = $('video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  $('scrim').classList.add('hidden');
  $('region').hidden = false;
  $('btnArm').disabled = false;
  resetBaseline();

  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => {
    // The portal was revoked, or the shared window closed. Stop pretending to
    // watch: an armed sentry with a dead stream is worse than no sentry.
    toast(
      kind === 'camera'
        ? 'The camera stopped, so watching stopped.'
        : 'The screen share ended, so watching stopped.',
      'error'
    );
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
  layoutExclusions();
  restartSampling({ force: true });
}

/** Forget the previous frame, in whichever mode holds it. */
function resetBaseline() {
  prevGray = null;
  hasExactBaseline = false;
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  clearInterval(sampleTimer);
  sampleTimer = null;
}

let samplingPeriod = 0;

/**
 * (Re)start the sample timer. Only the sample RATE can change it — every other
 * setting is read fresh inside sample(). Rebuilding the interval on any change
 * meant that dragging the sensitivity slider restarted the timer on every
 * pointer event, so it never got to fire and the meter froze at exactly the
 * moment you most want to watch it move.
 */
function restartSampling({ force = false } = {}) {
  const period = Math.round(1000 / (settings?.analyzeFps || 8));
  if (!force && sampleTimer && period === samplingPeriod && stream) return;
  clearInterval(sampleTimer);
  sampleTimer = null;
  if (!stream) return;
  samplingPeriod = period;
  sampleTimer = setInterval(sample, period);
}

function sample() {
  const video = $('video');
  if (!video.videoWidth) return;
  const r = settings.region;
  const vw = video.videoWidth, vh = video.videoHeight;
  const sx = Math.round(r.x * vw), sy = Math.round(r.y * vh);
  const sw = Math.max(2, Math.round(r.w * vw)), sh = Math.max(2, Math.round(r.h * vh));

  // Normally we analyse a thumbnail of the region rather than the region: 192px
  // on the long edge is plenty to see a person move and costs a fraction of a
  // millisecond. Pixel-exact mode does the opposite — 1:1, because a downscale
  // averages a single changed pixel into its neighbours and hides it.
  const exact = !!settings.pixelExact;
  const scale = exact
    ? Math.min(1, Math.sqrt(EXACT_MAX_PIXELS / (sw * sh)))
    : Math.min(1, 192 / Math.max(sw, sh));
  const aw = Math.max(8, Math.round(sw * scale));
  const ah = Math.max(8, Math.round(sh * scale));
  if (work.width !== aw || work.height !== ah) {
    work.width = aw;
    work.height = ah;
    bufA = new Uint8Array(aw * ah);
    bufB = new Uint8Array(aw * ah);
    prevRGBA = new Uint8ClampedArray(aw * ah * 4);
    prevGray = null; // the old baseline describes a different rectangle
    hasExactBaseline = false;
  }
  lastAnalysis = { aw, ah, sw, sh, exact, capped: exact && scale < 1 };

  // Rebuilding the mask costs a pass over the buffer, so it happens only when
  // the grid or the rectangles it is drawn from actually change.
  const key = `${aw}x${ah}|${JSON.stringify(settings.region)}|${JSON.stringify(settings.exclusions)}`;
  if (key !== maskKey) {
    maskKey = key;
    mask = buildMask(aw, ah, settings.region, settings.exclusions);
  }

  const t0 = performance.now();
  let data;
  try {
    wctx.drawImage(video, sx, sy, sw, sh, 0, 0, aw, ah);
    data = wctx.getImageData(0, 0, aw, ah).data;
  } catch {
    return; // a frame between resolution changes; the next one will be fine
  }

  let diff;
  if (exact) {
    // getImageData hands back a fresh buffer every call, so the baseline is a
    // persistent copy rather than a kept reference — one memcpy, no per-frame
    // allocation of a multi-megabyte array.
    diff = hasExactBaseline
      ? frameDiffRGBA(prevRGBA, data, aw, ah, params.pixelThreshold, mask)
      : { changed: 0, total: mask ? mask.unmasked : aw * ah, ratio: 0, bbox: null };
    prevRGBA.set(data);
    hasExactBaseline = true;
    prevGray = null;
  } else {
    const curr = toGray(data, useA ? bufA : bufB);
    diff = frameDiff(prevGray, curr, aw, ah, params.pixelThreshold, mask);
    prevGray = curr;
    useA = !useA;
    hasExactBaseline = false;
  }

  // Pixel-exact analysis is linear in the region's area, and a sample that
  // takes longer than its own interval quietly starves the UI. Measure it and
  // show it, so "the region is too big for this rate" is visible rather than
  // felt as a sluggish window.
  sampleCostMs = sampleCostMs ? sampleCostMs * 0.8 + (performance.now() - t0) * 0.2 : performance.now() - t0;

  const snap = gate.update(diff, performance.now());
  paint(snap, diff, { aw, ah });
  if (snap.fired) onMotion(snap, diff, { aw, ah });
}

// ---------------------------------------------------------------------------
// Arm / alarm
// ---------------------------------------------------------------------------

function arm() {
  if (!stream) return;
  alarm.ensure(); // this click is the gesture that unlocks audio
  resetBaseline();
  gate.arm(performance.now());
  paint(gate.update(0, performance.now()), { ratio: 0, bbox: null }, null);
}

function disarm() {
  gate.disarm();
  alarm.stop();
  hideBanner();
  paint(gate.update(0, performance.now()), { ratio: 0, bbox: null }, null);
}

function dismiss() {
  gate.dismiss(performance.now());
  alarm.stop();
  hideBanner();
  paint(gate.update(0, performance.now()), { ratio: 0, bbox: null }, null);
}

function onMotion(snap, diff, dims) {
  // Before anything slow: the picture must come from the frame that fired.
  const shot = takeSnapshot(diff, dims);
  alarm.start(settings.alarmSound, {
    volume: settings.alarmVolume,
    durationMs: settings.alarmMs,
    hold: settings.holdUntilDismissed,
  });
  if (!alarm.ready) {
    // Firing silently is the worst failure this app has. Say so, every time,
    // rather than letting a muted sentry look like a working one.
    toast('Motion detected, but the alarm could not sound — run the sound check in the Alarm panel.', 'error');
  }
  const share = (diff.ratio * 100).toFixed(2);
  api.alert({
    title: 'Motion detected',
    body: `${diff.changed ?? 0} pixels (${share}%) of the watched area changed.`,
    show: false,
  });
  logEvent(shot?.at ?? new Date(), diff, shot);
  showBanner(shot?.at ?? new Date(), diff.ratio);
}

// ---------------------------------------------------------------------------
// Trigger snapshots — the evidence
// ---------------------------------------------------------------------------

// "Something moved" is not an answer when you were not in the room. Every
// trigger keeps a picture of the watched area at the moment it fired, with the
// moving part outlined, so the log can say WHAT moved and not just when.
const snaps = [];
const snapCanvas = document.createElement('canvas');
const SNAP_MAX = 720; // long edge of a kept image

/**
 * Grab the watched region at the moment of the trigger and outline what moved.
 * JPEG at 0.82: a few tens of kilobytes each, which is what makes keeping two
 * dozen of them in memory unremarkable.
 */
function takeSnapshot(diff, dims) {
  const video = $('video');
  if (!video.videoWidth || !settings.keepSnapshots) return null;
  const r = settings.region;
  const sw = Math.max(2, Math.round(r.w * video.videoWidth));
  const sh = Math.max(2, Math.round(r.h * video.videoHeight));
  const k = Math.min(1, SNAP_MAX / Math.max(sw, sh));
  const w = Math.max(16, Math.round(sw * k));
  const h = Math.max(16, Math.round(sh * k));
  snapCanvas.width = w;
  snapCanvas.height = h;
  const ctx = snapCanvas.getContext('2d');
  try {
    ctx.drawImage(video, Math.round(r.x * video.videoWidth), Math.round(r.y * video.videoHeight), sw, sh, 0, 0, w, h);
  } catch {
    return null; // a frame we cannot read is not worth failing the alarm over
  }
  // The ignored areas, so a picture explains why a moving thing did not count.
  for (const e of settings.exclusions || []) {
    const ex = ((e.x - r.x) / r.w) * w;
    const ey = ((e.y - r.y) / r.h) * h;
    const ew = (e.w / r.w) * w;
    const eh = (e.h / r.h) * h;
    ctx.fillStyle = 'rgba(4, 2, 10, 0.55)';
    ctx.fillRect(ex, ey, ew, eh);
    ctx.strokeStyle = 'rgba(154, 143, 192, 0.9)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(ex + 0.5, ey + 0.5, ew - 1, eh - 1);
    ctx.setLineDash([]);
  }
  if (diff.bbox && dims) {
    ctx.strokeStyle = '#ffb300';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      (diff.bbox.x / dims.aw) * w,
      (diff.bbox.y / dims.ah) * h,
      (diff.bbox.w / dims.aw) * w,
      (diff.bbox.h / dims.ah) * h
    );
  }
  const dataUrl = snapCanvas.toDataURL('image/jpeg', 0.82);
  const at = new Date();
  const snap = { at, dataUrl, ratio: diff.ratio, changed: diff.changed ?? 0, total: diff.total ?? 0 };
  snaps.unshift(snap);
  while (snaps.length > settings.keepSnapshots) snaps.pop();
  $('btnSlideshow').disabled = !snaps.length;
  if (settings.saveSnapshots) {
    api.snapshots
      .save({ dataUrl, stamp: `${stampDate(at)}_${hhmmss(at).replace(/:/g, '-')}` })
      .catch(() => {});
  }
  return snap;
}

const stampDate = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

// --- the viewer -------------------------------------------------------------

let viewer = null;

function openViewer(index = 0) {
  if (!snaps.length) return;
  closeViewer();
  let i = Math.min(Math.max(index, 0), snaps.length - 1);
  let playing = false;
  let timer = null;

  const scrim = document.createElement('div');
  scrim.className = 'scrim-full';
  const sheet = document.createElement('div');
  sheet.className = 'sheet viewer';
  const h = document.createElement('h2');
  h.textContent = 'What tripped the alarm';
  const figure = document.createElement('div');
  figure.className = 'shot';
  const img = document.createElement('img');
  figure.append(img);
  const cap = document.createElement('div');
  cap.className = 'shot-cap';
  const time = document.createElement('b');
  const detail = document.createElement('span');
  cap.append(time, detail);

  const bar = document.createElement('div');
  bar.className = 'row viewer-bar';
  const prev = document.createElement('button');
  prev.textContent = '‹ Previous';
  const play = document.createElement('button');
  play.className = 'primary';
  play.textContent = 'Play';
  const next = document.createElement('button');
  next.textContent = 'Next ›';
  const counter = document.createElement('span');
  counter.className = 'muted small mono';
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const reveal = document.createElement('button');
  reveal.className = 'ghost';
  reveal.textContent = 'Open saved folder';
  reveal.onclick = async () => {
    const res = await api.snapshots.reveal();
    if (!res?.ok) toast('Could not open the snapshots folder.', 'error');
  };
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.onclick = () => closeViewer();
  bar.append(prev, play, next, counter, spacer, reveal, close);

  const show = () => {
    const s2 = snaps[i];
    if (!s2) return;
    img.src = s2.dataUrl;
    time.textContent = hhmmss(s2.at);
    detail.textContent = `${s2.changed} px moved (${(s2.ratio * 100).toFixed(2)}% of the watched area)`;
    counter.textContent = `${i + 1} / ${snaps.length}`;
  };
  const step = (d) => {
    i = (i + d + snaps.length) % snaps.length;
    show();
  };
  const stop = () => {
    playing = false;
    clearInterval(timer);
    timer = null;
    play.textContent = 'Play';
  };
  play.onclick = () => {
    if (playing) return stop();
    playing = true;
    play.textContent = 'Pause';
    timer = setInterval(() => step(1), 1500);
  };
  prev.onclick = () => {
    stop();
    step(-1);
  };
  next.onclick = () => {
    stop();
    step(1);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft') { stop(); step(-1); }
    else if (e.key === 'ArrowRight') { stop(); step(1); }
    else if (e.code === 'Space') { e.preventDefault(); play.onclick(); }
  };
  document.addEventListener('keydown', onKey, true);

  sheet.append(h, figure, cap, bar);
  scrim.append(sheet);
  scrim.onclick = (e) => {
    if (e.target === scrim) closeViewer();
  };
  document.body.append(scrim);
  viewer = { scrim, onKey, stop };
  show();
}

function closeViewer() {
  if (!viewer) return;
  viewer.stop();
  document.removeEventListener('keydown', viewer.onKey, true);
  viewer.scrim.remove();
  viewer = null;
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

// The tray mirrors main's idea of the state, and main only learns it when the
// renderer says so. Arming, firing and dismissing all reported themselves, but
// an alarm that simply timed out into cooldown did not — so the tray sat on
// "Motion detected", with "Silence alarm" still enabled, until the next manual
// arm or disarm. Report every transition, and only transitions: this runs on
// every sample, and an IPC call per frame is not free.
let reportedState = null;
function reportState(snap) {
  const key = `${snap.armed}/${snap.alarming}`;
  if (key === reportedState) return;
  reportedState = key;
  api.setState({ armed: snap.armed, alarming: snap.alarming });
}

function paint(snap, diff, dims) {
  const state = snap.state;
  reportState(snap);
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

  // Meter: the trip line sits at a third of the trough, so a sample three times
  // the threshold fills it. The trip point is whichever of the two thresholds
  // bites first — the area percentage, or the absolute pixel floor.
  const total = diff.total || lastAnalysis.aw * lastAnalysis.ah || 0;
  const tripPixels = Math.max(
    settings.minChangedPixels,
    total ? Math.ceil((params.minAreaPct / 100) * total) : 1
  );
  const trip = total ? tripPixels / total : params.minAreaPct / 100;
  const shown = Math.min(1, diff.ratio / (trip * 3 || 1));
  $('meterFill').style.width = `${(shown * 100).toFixed(1)}%`;
  $('meterTick').style.left = '33.3%';
  // Pixel counts, not just percentages: at a high multiplier the percentage is
  // all zeroes and the only readable number is "how many pixels moved".
  const changed = diff.changed ?? 0;
  $('meterNow').textContent = `${changed} px moving · ${(diff.ratio * 100).toFixed(2)}%`;
  $('meterTrip').textContent = `trips at ${tripPixels} px`;

  const region = $('region');
  region.classList.toggle('armed', snap.armed && !snap.alarming);
  region.classList.toggle('hit', snap.alarming);

  if (dims && diff.bbox && snap.armed) showBlob(diff.bbox, dims);
  if (dims) showAnalysisHint();
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

function logEvent(date, diff, shot) {
  const log = $('log');
  log.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  const row = document.createElement('button');
  row.className = 'log-row';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = hhmmss(date);
  if (shot) {
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = shot.dataUrl;
    thumb.alt = '';
    row.append(t, thumb);
  } else {
    row.append(t);
  }
  const what = document.createElement('span');
  what.textContent = shot ? 'motion — click to see it' : 'motion in the watched area';
  const d = document.createElement('span');
  d.className = 'd';
  d.textContent = `${diff.changed ?? 0} px · ${(diff.ratio * 100).toFixed(2)}%`;
  row.append(what, d);
  // Snapshots age out of the front of the list, so a row finds its own picture
  // by identity rather than by a position that shifts under it.
  row.onclick = () => {
    const at = shot ? snaps.indexOf(shot) : -1;
    if (at >= 0) openViewer(at);
    else toast('That snapshot has aged out of the viewer.');
  };
  if (!shot) row.disabled = true;
  li.append(row);
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
// Zoom, panning and the magnifier
// ---------------------------------------------------------------------------

let zoom = 1;
const ZOOM_MIN = 1;
const ZOOM_MAX = 16;

/**
 * Scale the preview, keeping a point fixed under the cursor.
 *
 * Selecting a 3-pixel target on a 4K screen shown in a 700px preview is
 * hopeless at 1:1 — one preview pixel covers six screen pixels, so the
 * rectangle can only ever be approximate. Zooming is what makes the region
 * selectable at the resolution the detector actually samples.
 */
function setZoom(next, anchor) {
  const vp = $('viewport');
  const prev = zoom;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  // Where the anchor sits in content coordinates, before and after: keeping it
  // still is the difference between zooming and losing your place.
  const a = anchor || { x: vp.clientWidth / 2, y: vp.clientHeight / 2 };
  const cx = (vp.scrollLeft + a.x) / prev;
  const cy = (vp.scrollTop + a.y) / prev;
  vp.style.setProperty('--zoom', zoom);
  vp.scrollLeft = cx * zoom - a.x;
  vp.scrollTop = cy * zoom - a.y;
  $('zoomVal').textContent = `${Math.round(zoom * 100)}%`;
  layoutRegion();
}

function setupZoom() {
  const vp = $('viewport');
  $('zoomIn').addEventListener('click', () => setZoom(zoom * 1.5));
  $('zoomOut').addEventListener('click', () => setZoom(zoom / 1.5));
  $('zoomFit').addEventListener('click', () => setZoom(1));

  vp.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return; // plain scrolling still pans the well
      e.preventDefault();
      const b = vp.getBoundingClientRect();
      setZoom(zoom * (e.deltaY < 0 ? 1.25 : 1 / 1.25), { x: e.clientX - b.left, y: e.clientY - b.top });
    },
    { passive: false }
  );

  // Middle-drag pans, which beats hunting for scrollbars while zoomed in.
  let pan = null;
  vp.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    pan = { x: e.clientX, y: e.clientY, left: vp.scrollLeft, top: vp.scrollTop };
    vp.classList.add('panning');
    vp.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  vp.addEventListener('pointermove', (e) => {
    if (!pan) return;
    vp.scrollLeft = pan.left - (e.clientX - pan.x);
    vp.scrollTop = pan.top - (e.clientY - pan.y);
  });
  const endPan = () => {
    pan = null;
    vp.classList.remove('panning');
  };
  vp.addEventListener('pointerup', endPan);
  vp.addEventListener('pointercancel', endPan);
}

/**
 * Draw the magnifier: the source frame's real pixels around the pointer, at 10×
 * with smoothing off, plus a crosshair. This is what makes a 1-pixel target
 * selectable — the preview is scaled, the loupe never is.
 */
const LOUPE_SPAN = 15; // source pixels across the glass
function showLoupe(clientX, clientY, nx, ny) {
  const video = $('video');
  const loupe = $('loupe');
  if (!video.videoWidth) return;
  const ctx = loupe.getContext('2d');
  const sx = nx * video.videoWidth - LOUPE_SPAN / 2;
  const sy = ny * video.videoHeight - LOUPE_SPAN / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, loupe.width, loupe.height);
  try {
    ctx.drawImage(video, sx, sy, LOUPE_SPAN, LOUPE_SPAN, 0, 0, loupe.width, loupe.height);
  } catch {
    return;
  }
  const mid = loupe.width / 2;
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mid, 0);
  ctx.lineTo(mid, loupe.height);
  ctx.moveTo(0, mid);
  ctx.lineTo(loupe.width, mid);
  ctx.stroke();
  // the single source pixel under the cursor
  const cell = loupe.width / LOUPE_SPAN;
  ctx.strokeStyle = 'rgba(255, 179, 0, 0.95)';
  ctx.strokeRect(mid - cell / 2, mid - cell / 2, cell, cell);

  const wrap = loupe.parentElement; // .stage-wrap, the loupe's positioning box
  const b = wrap.getBoundingClientRect();
  // Keep the glass beside the cursor and inside the card.
  const left = Math.min(Math.max(clientX - b.left + 24, 0), b.width - loupe.width);
  const top = Math.min(Math.max(clientY - b.top - loupe.height - 16, 0), b.height - loupe.height);
  loupe.style.left = `${left}px`;
  loupe.style.top = `${top}px`;
  loupe.hidden = false;
}

function hideLoupe() {
  $('loupe').hidden = true;
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
  $('regionOrigin').textContent = v.videoWidth
    ? `top-left at ${Math.round(r.x * v.videoWidth)}, ${Math.round(r.y * v.videoHeight)} px of ${v.videoWidth}×${v.videoHeight}`
    : '';
}

/**
 * Draw the ignore rectangles over the preview.
 *
 * They live in the same coordinate space as the region (fractions of the frame)
 * and are absolutely positioned inside the stage, so zooming and panning move
 * them with everything else for free.
 */
function layoutExclusions() {
  const host = $('exclusions');
  const list = settings.exclusions || [];
  host.replaceChildren();
  list.forEach((e, i) => {
    const el = document.createElement('div');
    el.className = 'exclusion';
    el.dataset.index = String(i);
    el.style.left = `${e.x * 100}%`;
    el.style.top = `${e.y * 100}%`;
    el.style.width = `${e.w * 100}%`;
    el.style.height = `${e.h * 100}%`;
    el.title = 'Ignored area — drag to move, corner to resize';
    const del = document.createElement('button');
    del.className = 'x';
    del.textContent = '×';
    del.title = 'Remove this ignored area';
    del.onclick = (ev) => {
      ev.stopPropagation();
      removeExclusion(i);
    };
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.dataset.dir = 'se';
    el.append(del, grip);
    host.append(el);
  });
  $('exclusionCount').textContent = list.length
    ? `${list.length} ignored area${list.length === 1 ? '' : 's'}`
    : 'No ignored areas';
  $('btnClearExclusions').hidden = !list.length;
  maskKey = ''; // force a rebuild on the next sample
  resetBaseline();
}

function removeExclusion(i) {
  const next = (settings.exclusions || []).filter((_, n) => n !== i);
  patch({ exclusions: next }, { immediate: true });
  layoutExclusions();
}

// Arm-to-draw: the next drag on the preview cuts an ignore rectangle instead of
// moving the watched region. One-shot, because leaving the preview in a
// different mode than it looks is how you lose a carefully drawn region.
const EX_MIN = 0.005; // an ignore area may be much smaller than the region
let drawingExclusion = false;
function setExclusionMode(on) {
  drawingExclusion = on;
  $('btnAddExclusion').setAttribute('aria-pressed', String(on));
  $('stage').classList.toggle('excluding', on);
  $('watchHint').textContent = on
    ? 'Drag over the part to ignore — motion inside it will never count. Press Esc to cancel.'
    : 'Drag on the preview to draw the area. Drag inside it to move it, or grab a corner to resize.';
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
    if (e.button !== 0) return; // middle-drag pans, right-click is not ours
    const p = pointAt(e);
    const exEl = e.target.closest?.('.exclusion');

    if (drawingExclusion) {
      const list = [...(settings.exclusions || []), { x: p.x, y: p.y, w: EX_MIN, h: EX_MIN }];
      settings.exclusions = list;
      drag = { target: 'exclusion', index: list.length - 1, mode: 'new', from: p, start: { ...list[list.length - 1] } };
      layoutExclusions();
    } else if (exEl) {
      const index = Number(exEl.dataset.index);
      const grip = e.target.closest?.('.grip');
      drag = {
        target: 'exclusion',
        index,
        mode: grip ? 'se' : 'move',
        from: p,
        start: { ...settings.exclusions[index] },
      };
    } else {
      const grip = e.target.closest?.('.grip');
      const inRegion = e.target.closest?.('.region');
      drag = {
        target: 'region',
        mode: grip ? grip.dataset.dir : inRegion ? 'move' : 'new',
        from: p,
        start: { ...settings.region },
      };
      if (drag.mode === 'new') {
        settings.region = { x: p.x, y: p.y, w: MIN, h: MIN };
        layoutRegion();
      }
    }
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    const hover = pointAt(e);
    if (stream) showLoupe(e.clientX, e.clientY, hover.x, hover.y);
    if (!drag) return;
    const p = hover;
    const s = drag.start;
    let r;
    if (drag.target === 'exclusion') {
      if (drag.mode === 'new') {
        r = { x: Math.min(drag.from.x, p.x), y: Math.min(drag.from.y, p.y), w: Math.abs(p.x - drag.from.x), h: Math.abs(p.y - drag.from.y) };
      } else if (drag.mode === 'move') {
        r = { x: clamp01(Math.min(s.x + (p.x - drag.from.x), 1 - s.w)), y: clamp01(Math.min(s.y + (p.y - drag.from.y), 1 - s.h)), w: s.w, h: s.h };
      } else {
        r = { x: s.x, y: s.y, w: p.x - s.x, h: p.y - s.y };
      }
      r.w = Math.max(EX_MIN, Math.min(r.w, 1 - r.x));
      r.h = Math.max(EX_MIN, Math.min(r.h, 1 - r.y));
      settings.exclusions[drag.index] = r;
      layoutExclusions();
      return;
    }
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
    resetBaseline(); // the baseline belongs to the old rectangle
    layoutRegion();
  });

  stage.addEventListener('pointerleave', hideLoupe);

  const end = () => {
    hideLoupe();
    if (!drag) return;
    const wasExclusion = drag.target === 'exclusion';
    drag = null;
    if (wasExclusion) {
      patch({ exclusions: settings.exclusions }, { immediate: true });
      setExclusionMode(false);
      layoutExclusions();
    } else {
      patch({ region: settings.region }, { immediate: true });
      layoutRegion();
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------------------
// Source picker
// ---------------------------------------------------------------------------

async function pickSource() {
  layoutExclusions();

  // A camera needs no portal handshake, so the app can pick up where it left
  // off. A screen share cannot: resuming one would throw a permission dialog in
  // the user's face on every launch, which is worse than one deliberate click.
  if (!info.mock && settings.resumeCamera && settings.lastCamera) {
    const cams = await listCameras();
    const found = cams.find((c) => c.id === settings.lastCamera);
    if (found) await takeCamera(found);
  }

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
  const cameras = await listCameras();
  if (!sources.length && !cameras.length) {
    toast('No cameras, screens or windows were offered.', 'error');
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

  // Cameras first: they are the only source that opens without a portal
  // handshake, so they are also the only one worth reaching for twice.
  if (cameras.length) {
    const label = document.createElement('div');
    label.className = 'group-label';
    label.textContent = 'Cameras';
    sheet.append(h, label);
    const camGrid = document.createElement('div');
    camGrid.className = 'sources';
    for (const c of cameras) {
      const btn = document.createElement('button');
      btn.className = 'source';
      const art = document.createElement('div');
      art.className = 'cam-art';
      art.innerHTML =
        '<svg viewBox="0 0 48 32" width="56" height="38" aria-hidden="true">' +
        '<rect x="1" y="5" width="30" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M33 13l12-6v18l-12-6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
        '</svg>';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = c.name;
      const kd = document.createElement('div');
      kd.className = 'kd';
      kd.textContent = 'camera';
      meta.append(nm, kd);
      btn.append(art, meta);
      btn.onclick = () => {
        scrim.remove();
        takeCamera(c);
      };
      camGrid.append(btn);
    }
    sheet.append(camGrid);
    const label2 = document.createElement('div');
    label2.className = 'group-label';
    label2.textContent = 'Screens and windows';
    sheet.append(label2);
  }

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
  if (!cameras.length) sheet.append(h);
  sheet.append(grid, note, cancel);
  scrim.append(sheet);
  scrim.onclick = (e) => {
    if (e.target === scrim) scrim.remove();
  };
  document.body.append(scrim);
}

async function takeCamera(camera) {
  try {
    await useStream(await startCamera(camera.id), { kind: 'camera' });
    $('sourceName').textContent = camera.name;
    // Remember it by id, not by index: unplugging one camera renumbers the rest.
    patch({ lastCamera: camera.id }, { immediate: true });
  } catch (err) {
    toast(`Could not open ${camera.name} — ${err.message}`, 'error');
  }
}

async function takeSource(source) {
  try {
    await useStream(await startCapture(source.id, api), { kind: 'screen' });
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
      if (['sensitivity', 'sensitivityBoost', 'minChangedPixels'].includes(key)) showSensHint();
    });
  };

  slider('sens', 'sensVal', 'sensitivity', (v) => String(v));
  // The multiplier slider is geometric: ×1 at one end, ×1000 at the other, so
  // the useful decade-by-decade range is spread evenly across the travel.
  slider('boost', 'boostVal', 'sensitivityBoost', (v) => `×${v}`, sliderFromBoost, boostFromSlider);
  slider('minPx', 'minPxVal', 'minChangedPixels', (v) => `${v} px`);
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
  toggle('tExact', 'pixelExact', () => {
    resetBaseline(); // the old baseline is a thumbnail, or was one
    showSensHint();
  });
  toggle('tNotify', 'notify');
  toggle('tSaveShots', 'saveSnapshots');
  toggle('tResumeCam', 'resumeCamera');
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
  $('btnCheck').addEventListener('click', soundCheck);
  $('outDev').addEventListener('change', async () => {
    const id = $('outDev').value;
    patch({ outputDeviceId: id }, { immediate: true });
    alarm.ensure();
    await alarm.setOutputDevice(id);
    alarm.test(settings.alarmSound, settings.alarmVolume); // hear where it went
  });
  refreshOutputs();
  // Devices come and go — a headset unplugged while the app runs must not leave
  // a stale list, and a newly plugged one should be selectable without a restart.
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshOutputs);
  $('btnSource').addEventListener('click', pickSource);
  $('btnSourceEmpty').addEventListener('click', pickSource);
  $('btnTray').addEventListener('click', () => api.hideWindow());
  $('btnArm').addEventListener('click', () => (gate.armed ? disarm() : arm()));
  $('btnWhole').addEventListener('click', () => {
    patch({ region: { x: 0, y: 0, w: 1, h: 1 } }, { immediate: true });
    resetBaseline();
    layoutRegion();
  });
  $('btnAddExclusion').addEventListener('click', () => setExclusionMode(!drawingExclusion));
  $('btnClearExclusions').addEventListener('click', () => {
    patch({ exclusions: [] }, { immediate: true });
    layoutExclusions();
  });
  $('btnSlideshow').addEventListener('click', () => openViewer(0));

  $('btnCentre').addEventListener('click', () => {
    patch({ region: { x: 1 / 3, y: 1 / 3, w: 1 / 3, h: 1 / 3 } }, { immediate: true });
    resetBaseline();
    layoutRegion();
  });

  document.addEventListener('keydown', (e) => {
    if (nudgeRegion(e)) return;
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

/** Fill the output picker with the system's audio outputs, keeping the choice. */
async function refreshOutputs() {
  const sel = $('outDev');
  if (!alarm.canRoute) {
    // Without setSinkId the app cannot route anywhere but the default, and a
    // dead control that silently does nothing is worse than none.
    sel.disabled = true;
    $('outDevNote').textContent = 'not supported by this build';
    return;
  }
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  } catch {
    /* keep the default-only list */
  }
  const chosen = settings.outputDeviceId || '';
  sel.textContent = '';
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    if (value === chosen) o.selected = true;
    sel.append(o);
  };
  add('', 'System default output');
  for (const d of devices) {
    if (d.deviceId === 'default' || !d.deviceId) continue;
    add(d.deviceId, d.label || `Output ${d.deviceId.slice(0, 6)}`);
  }
  // A device that has since been unplugged would otherwise vanish silently.
  if (chosen && ![...sel.options].some((o) => o.value === chosen)) {
    add(chosen, 'Saved device (not currently connected)');
    sel.value = chosen;
  }
  $('outDevNote').textContent = devices.length ? '' : 'no devices listed';
  await alarm.setOutputDevice(chosen);
}

/**
 * Play one bar and report what actually left the audio graph. Every failure
 * here is silent by nature, so each one gets a sentence saying what to do:
 * a suspended context needs a click, a silent graph at a running context is the
 * system's output routing, not ours.
 */
async function soundCheck() {
  const btn = $('btnCheck');
  btn.disabled = true;
  $('soundHint').textContent = 'Playing a test tone and listening to the output…';
  $('soundHint').classList.remove('warn');
  try {
    const r = await alarm.check(settings.alarmSound, settings.alarmVolume);
    const warn = !r.ok;
    $('soundHint').classList.toggle('warn', warn);
    $('soundHint').textContent =
      r.reason === 'ok'
        ? `Sound is working — peak ${r.peak} at ${Math.round(r.sampleRate / 1000)}kHz, playing on ${outputLabel(r.sinkId)}. If you did not hear it, that device is not the one you are listening to: pick another above.`
        : r.reason === 'suspended'
          ? 'The browser audio engine is suspended, so alarms are silent. Click anywhere in this window, then run the check again.'
          : r.reason === 'no-audio'
            ? 'This build could not create an audio engine at all, so alarms cannot sound. Desktop notifications still work.'
            : `The alarm ran but produced no signal (peak ${r.peak}). Raise the alarm volume, or check the app's level in the system volume mixer.`;
    if (warn) toast('Sound check failed — see the alarm panel.', 'error');
  } finally {
    btn.disabled = false;
  }
}

function outputLabel(sinkId) {
  const sel = $('outDev');
  const opt = [...sel.options].find((o) => o.value === (sinkId || ''));
  return opt ? opt.textContent : 'the system default output';
}

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Move the region by one SOURCE pixel per key press (Shift resizes the far edge
 * instead). Dragging can only ever be as precise as the preview's scale; this
 * is exact at any zoom, which is what a small target needs.
 */
function nudgeRegion(e) {
  const step = ARROWS[e.key];
  if (!step || !stream) return false;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return false;
  const video = $('video');
  if (!video.videoWidth) return false;
  e.preventDefault();

  const [dx, dy] = step;
  const stepX = (dx * (e.altKey ? 10 : 1)) / video.videoWidth;
  const stepY = (dy * (e.altKey ? 10 : 1)) / video.videoHeight;
  const r = { ...settings.region };
  if (e.shiftKey) {
    r.w = Math.min(1 - r.x, Math.max(2 / video.videoWidth, r.w + stepX));
    r.h = Math.min(1 - r.y, Math.max(2 / video.videoHeight, r.h + stepY));
  } else {
    r.x = Math.min(1 - r.w, Math.max(0, r.x + stepX));
    r.y = Math.min(1 - r.h, Math.max(0, r.y + stepY));
  }
  settings.region = r;
  resetBaseline();
  layoutRegion();
  patch({ region: r }, { immediate: true });
  return true;
}

function showSensHint() {
  const what = settings.pixelExact ? 'in any colour channel' : 'in brightness';
  const how =
    params.pixelThreshold === 0
      ? `changes at all ${what}`
      : `changes by more than ${params.pixelThreshold} of 255 ${what}`;
  $('sensHint').textContent =
    `Fires when at least ${pct(params.minAreaPct)}% of the area — and at least ` +
    `${settings.minChangedPixels} pixel${settings.minChangedPixels === 1 ? '' : 's'} — ${how}.`;
  showAnalysisHint();
}

// What the detector is actually looking at, in numbers: the difference between
// "one pixel changed" and "one pixel of a thumbnail changed" is the whole point
// of pixel-exact mode, so it is stated rather than implied.
function showAnalysisHint() {
  const a = lastAnalysis;
  if (!a.aw) {
    $('analysisHint').textContent = '';
    return;
  }
  const region = `${a.sw}×${a.sh}`;
  const cost = sampleCostMs >= 0.05 ? ` · ${sampleCostMs.toFixed(1)} ms/sample` : '';
  const ignored = mask ? ` · ${Math.round((mask.ignored / (a.aw * a.ah)) * 100)}% ignored` : '';
  const overrun = samplingPeriod && sampleCostMs > samplingPeriod * 0.8;
  $('analysisHint').classList.toggle('warn', !!overrun);
  if (overrun) {
    $('analysisHint').textContent =
      `analysing ${a.aw}×${a.ah}${cost} — that is more than one sample fits in at ` +
      `${settings.analyzeFps}/s. Lower the sample rate or draw a smaller area.`;
    return;
  }
  if (!a.exact) {
    $('analysisHint').textContent = `analysing ${a.aw}×${a.ah} downscaled from ${region}${cost}${ignored} — one sample covers ~${Math.max(1, Math.round(a.sw / a.aw))}×${Math.max(1, Math.round(a.sh / a.ah))} screen pixels`;
  } else if (a.capped) {
    $('analysisHint').textContent = `region too large for 1:1 — analysing ${a.aw}×${a.ah} of ${region}${cost}. Draw a smaller area for true pixel-exact watching.`;
  } else {
    $('analysisHint').textContent = `analysing ${a.aw}×${a.ah} at 1:1${cost}${ignored} — one sample is one screen pixel`;
  }
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
  setupZoom();
  bindSheen();
  layoutRegion();
  showSensHint();
  paint(gate.update(0, performance.now()), { ratio: 0, bbox: null }, null);

  alarm.onError = (err) => toast(`The alarm could not play — ${err.message}`, 'error');

  // Warm the audio engine on the first interaction of any kind. A browser audio
  // context created outside a user gesture can come up suspended and stay that
  // way, which turns every later alarm into silence — and an alarm app that is
  // silently mute is worse than one that never started. Any click or key press
  // in the window is enough, and after that the graph is ready before it is
  // ever needed.
  const warm = () => alarm.ensure();
  document.addEventListener('pointerdown', warm, { once: true });
  document.addEventListener('keydown', warm, { once: true });
  layoutExclusions();

  // A camera needs no portal handshake, so the app can pick up where it left
  // off. A screen share cannot: resuming one would throw a permission dialog in
  // the user's face on every launch, which is worse than one deliberate click.
  if (!info.mock && settings.resumeCamera && settings.lastCamera) {
    const cams = await listCameras();
    const found = cams.find((c) => c.id === settings.lastCamera);
    if (found) await takeCamera(found);
  }

  if (info.mock) {
    // Headless runs go straight to the fake desktop, and NX_SENTRY_AUTOARM=1
    // additionally arms the sentry so a screenshot can show the live states.
    await pickSource();
    if (info.autoArm) arm();
    // Mock-only: let the headless harness photograph states a screenshot cannot
    // reach on its own, since it has no pointer to drive. NX_SENTRY_DEMO=zoom=4
    if (info.demo) {
      const z = /zoom=([\d.]+)/.exec(info.demo);
      if (z) setZoom(Number(z[1]));
      if (/loupe/.test(info.demo)) {
        const r = settings.region;
        const b = $('stage').getBoundingClientRect();
        setTimeout(
          () => showLoupe(b.left + b.width * (r.x + r.w), b.top + b.height * (r.y + r.h), r.x + r.w, r.y + r.h),
          400
        );
      }
    }
  }
}

boot();
