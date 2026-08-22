// src/renderer/capture.js — where the pixels come from.
//
// Real capture goes through getDisplayMedia, which the main process answers by
// handing Chromium a desktopCapturer source. On a Wayland session that is what
// makes xdg-desktop-portal show its own picker, so the compositor — not this
// app — decides what we are allowed to see.
//
// The mock source draws a fake desktop with something moving in it. It exists
// so the UI and the whole detect → alarm path can be exercised in a headless
// compositor with no portal dialog, and so nobody has to point a live capture
// at their own screen just to check that a button lines up.

export async function startCapture(sourceId, api) {
  if (sourceId) await api.sources.select(sourceId);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } },
    audio: false,
  });
  return stream;
}

/**
 * The cameras this machine has. On Linux these come from V4L2 through
 * Chromium's capture stack, so a UVC webcam, a capture card and a v4l2loopback
 * device all appear the same way — no portal, no permission dialog per launch.
 *
 * Labels are only populated once the page holds a media permission, which is
 * why main grants it; without one the browser returns anonymous entries and we
 * number them instead of showing empty names.
 */
export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({
      id: d.deviceId,
      name: d.label || `Camera ${i + 1}`,
      kind: 'camera',
    }));
}

/**
 * Open one camera. `exact` on the deviceId matters: without it the browser is
 * free to hand back a different camera than the one that was picked, which on a
 * machine with a webcam and a capture card is a coin toss.
 */
export async function startCamera(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
}

/** A 1280×720 synthetic desktop: static chrome plus a shape that moves in bursts. */
export function startMock() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const start = performance.now();

  const draw = () => {
    const t = (performance.now() - start) / 1000;
    // desk
    const g = ctx.createLinearGradient(0, 0, 0, 720);
    g.addColorStop(0, '#101828');
    g.addColorStop(1, '#0b0f18');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1280, 720);
    // two still "windows" so the frame is not uniformly empty
    ctx.fillStyle = '#1b2436';
    ctx.fillRect(60, 70, 520, 330);
    ctx.fillRect(680, 300, 520, 340);
    ctx.fillStyle = '#2b3852';
    ctx.fillRect(60, 70, 520, 26);
    ctx.fillRect(680, 300, 520, 26);
    ctx.fillStyle = '#38455f';
    for (let i = 0; i < 7; i++) ctx.fillRect(84, 124 + i * 26, 300 - (i % 3) * 70, 8);
    // taskbar
    ctx.fillStyle = '#161d2b';
    ctx.fillRect(0, 684, 1280, 36);

    // The mover: 3 seconds of travel, 4 seconds of stillness, so arming,
    // triggering and the quiet cooldown are all visible in one loop.
    const phase = t % 7;
    const moving = phase < 3;
    const p = moving ? phase / 3 : 1;
    const x = 720 + Math.sin(p * Math.PI * 2) * 240;
    const y = 430 + Math.cos(p * Math.PI * 2) * 90;
    ctx.fillStyle = moving ? '#9a3cff' : '#4a3a6b';
    ctx.beginPath();
    ctx.arc(x, y, 46, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#7788aa';
    ctx.font = '16px monospace';
    ctx.fillText(`mock desktop · ${moving ? 'moving' : 'still'}`, 24, 706);
    requestAnimationFrame(draw);
  };
  draw();

  return canvas.captureStream(20);
}

export default { startCapture, startMock, listCameras, startCamera };
