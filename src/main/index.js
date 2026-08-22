// src/main/index.js — Electron bootstrap. Owns the window, the tray, the
// settings file and the screen-capture permission handshake. All detection and
// all sound live in the renderer (that is where the video frames and the audio
// context are); this file stays a thin shell so the interesting code can be
// tested headless.

import { app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, ipcMain, nativeImage, powerSaveBlocker, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const RENDERER = join(ROOT, 'src', 'renderer', 'index.html');
const ICON_PNG = join(ROOT, 'assets', 'icon.png');
const TRAY_IDLE = join(ROOT, 'assets', 'tray.png');
const TRAY_ARMED = join(ROOT, 'assets', 'tray-armed.png');

// NX_SENTRY_MOCK=1 replaces the real screen capture with a synthetic desktop
// that has something moving in it. It is how the UI and the whole detect →
// alarm path get verified in a headless compositor, with no portal dialog and
// without pointing a capture stream at the developer's actual screen.
const MOCK = process.env.NX_SENTRY_MOCK === '1';

let win = null;
let tray = null;
let quitting = false;
let blockerId = null;
let armedState = { armed: false, alarming: false };
// The source the renderer asked to capture, consumed by the display-media
// handler below. Chromium asks main for the source; the renderer only ever
// names an id it got from us.
let pendingSourceId = null;

// Wayland: Chromium captures the screen through the xdg-desktop-portal +
// PipeWire path. Ozone/Wayland is picked up automatically on a Wayland session,
// but the capturer feature has to be on or getDisplayMedia yields a black frame.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}
// The detector runs on a timer in the renderer. A watchdog that stops watching
// when you minimise it is not a watchdog.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// A test or headless run must not share ANYTHING with the copy the user has
// installed. $NX_SENTRY_CONFIG_DIR already redirects settings.json, but
// Electron's own userData directory holds the single-instance lock, the cache
// and the GPU state — leave it at the default and a headless run either quits
// instantly because the real app holds the lock, or pops the real app's window
// to the front via 'second-instance'. Redirect it with the settings.
if (process.env.NX_SENTRY_CONFIG_DIR) {
  app.setPath('userData', join(config.configDir(), 'electron'));
}

if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0a0714',
    title: 'NX Sentry',
    icon: existsSync(ICON_PNG) ? ICON_PNG : undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Hidden or occluded, the renderer must keep sampling frames at full rate.
      backgroundThrottling: false,
    },
  });

  win.loadFile(RENDERER);
  win.once('ready-to-show', () => win.show());

  // Closing the window parks the sentry in the tray instead of killing it —
  // that is the whole point of a watcher. Quit is explicit (tray or Ctrl+Q).
  win.on('close', (e) => {
    if (quitting || !config.load().minimizeToTray) return;
    e.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    win = null;
  });

  // Links in the UI (the repo, the design doc) open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });

  installCaptureHandler();

  // enumerateDevices() only labels audio outputs for a page that holds media
  // permission, and without labels an output picker is a list of opaque ids.
  // Granting it costs nothing here: the renderer has no getUserMedia call for a
  // microphone, and screen capture still goes through the portal.
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'media')
  );
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
}

// ---------------------------------------------------------------------------
// Screen capture
// ---------------------------------------------------------------------------

function installCaptureHandler() {
  // getDisplayMedia() in the renderer lands here. On Wayland, handing back a
  // desktopCapturer source is what makes Chromium open the desktop portal's
  // own picker — the OS stays in charge of what we are allowed to see.
  win.webContents.session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const chosen = sources.find((s) => s.id === pendingSourceId) || sources.find((s) => s.id.startsWith('screen:')) || sources[0];
        if (!chosen) return callback({});
        callback({ video: chosen });
      } catch (err) {
        console.error('[capture] source lookup failed:', err.message);
        callback({});
      }
    },
    // Chromium's own picker would be a second dialog on top of the portal's.
    { useSystemPicker: false }
  );
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayImage(armed) {
  const file = armed && existsSync(TRAY_ARMED) ? TRAY_ARMED : TRAY_IDLE;
  const img = existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  return img.isEmpty() ? img : img.resize({ width: 22, height: 22 });
}

function refreshTray() {
  if (!tray) return;
  const { armed, alarming } = armedState;
  tray.setImage(trayImage(armed));
  tray.setToolTip(alarming ? 'NX Sentry — motion detected' : armed ? 'NX Sentry — watching' : 'NX Sentry — idle');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: alarming ? 'Motion detected' : armed ? 'Watching' : 'Not watching', enabled: false },
      { type: 'separator' },
      {
        label: armed ? 'Stop watching' : 'Start watching',
        click: () => win?.webContents.send('sentry:command', armed ? 'disarm' : 'arm'),
      },
      { label: 'Silence alarm', enabled: alarming, click: () => win?.webContents.send('sentry:command', 'dismiss') },
      { type: 'separator' },
      { label: 'Show window', click: () => showWindow() },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ])
  );
}

function showWindow() {
  if (!win) createWindow();
  else {
    win.show();
    win.focus();
  }
}

// ---------------------------------------------------------------------------
// IPC — the whole `window.sentry` surface
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('sentry:settings.get', () => config.load());
  ipcMain.handle('sentry:settings.set', (_e, patch) => config.save(patch));

  ipcMain.handle('sentry:app.info', () => ({
    version: app.getVersion(),
    mock: MOCK,
    autoArm: process.env.NX_SENTRY_AUTOARM === '1',
    demo: process.env.NX_SENTRY_DEMO || '',
    platform: process.platform,
    wayland: process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY,
    configPath: config.configPath(),
  }));

  ipcMain.handle('sentry:sources.list', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail?.isEmpty() ? null : s.thumbnail.toDataURL(),
    }));
  });

  // The renderer names the source it is about to request; the handler above
  // consumes it on the next getDisplayMedia call.
  ipcMain.handle('sentry:sources.select', (_e, id) => {
    pendingSourceId = typeof id === 'string' ? id : null;
    return pendingSourceId;
  });

  ipcMain.handle('sentry:state.set', (_e, state) => {
    armedState = { armed: !!state?.armed, alarming: !!state?.alarming };
    refreshTray();
    // Watching is worthless if the machine suspends the app mid-vigil.
    if (armedState.armed && blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!armedState.armed && blockerId !== null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    return armedState;
  });

  ipcMain.handle('sentry:alert', (_e, { title, body, show } = {}) => {
    const settings = config.load();
    if (settings.notify && Notification.isSupported()) {
      const n = new Notification({
        title: title || 'NX Sentry',
        body: body || 'Motion in the watched area',
        icon: existsSync(ICON_PNG) ? ICON_PNG : undefined,
        urgency: 'critical',
      });
      n.on('click', () => showWindow());
      n.show();
    }
    if (settings.flashWindow && win) {
      // flashFrame is a taskbar hint; some Wayland shells ignore it, so an
      // explicit `show` request from the renderer raises the window instead.
      win.flashFrame(true);
      if (show) showWindow();
    }
    return true;
  });

  ipcMain.handle('sentry:window.hide', () => win?.hide());

  // Trigger snapshots, when the user has turned saving on. They are written
  // under the config directory and nowhere else — this is a webcam's worth of
  // privacy, so the path is not caller-controlled: the renderer supplies image
  // bytes and a timestamp, main decides where they land.
  ipcMain.handle('sentry:snapshots.save', (_e, { dataUrl, stamp } = {}) => {
    if (!config.load().saveSnapshots) return null;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,')) return null;
    const dir = join(config.configDir(), 'snapshots');
    const name = `${String(stamp || '').replace(/[^0-9T:_-]/g, '').slice(0, 32) || 'snapshot'}.jpg`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
      return join(dir, name);
    } catch (err) {
      console.warn('[snapshots] save failed:', err.message);
      return null;
    }
  });

  ipcMain.handle('sentry:snapshots.reveal', async () => {
    const dir = join(config.configDir(), 'snapshots');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* shown as a failure below */
    }
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true, dir };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('second-instance', () => showWindow());
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => showWindow());

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  try {
    tray = new Tray(trayImage(false));
    refreshTray();
    tray.on('click', () => (win?.isVisible() ? win.hide() : showWindow()));
  } catch (err) {
    // A session without a StatusNotifier host still runs fine, just windowed.
    console.warn('[tray] unavailable:', err.message);
  }
});
