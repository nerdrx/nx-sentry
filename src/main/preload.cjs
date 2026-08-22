// src/main/preload.cjs — the only bridge into the sandboxed renderer. Every
// method is a thin invoke of a whitelisted 'sentry:*' channel; the renderer
// gets no fs, no network and no Electron internals.
//
// CommonJS on purpose: Electron loads sandboxed preloads with a CJS loader, so
// an ESM preload silently never installs the bridge. The package is
// "type":"module", hence the explicit .cjs extension.

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke('sentry:' + channel, ...args);

contextBridge.exposeInMainWorld('sentry', {
  info: () => call('app.info'),
  settings: {
    get: () => call('settings.get'),
    set: (patch) => call('settings.set', patch),
  },
  sources: {
    list: () => call('sources.list'),
    select: (id) => call('sources.select', id),
  },
  setState: (state) => call('state.set', state),
  alert: (payload) => call('alert', payload),
  hideWindow: () => call('window.hide'),
  snapshots: {
    save: (payload) => call('snapshots.save', payload),
    reveal: () => call('snapshots.reveal'),
  },
  // Tray menu items arrive here: 'arm' | 'disarm' | 'dismiss'.
  onCommand: (fn) => {
    const listener = (_e, cmd) => fn(cmd);
    ipcRenderer.on('sentry:command', listener);
    return () => ipcRenderer.removeListener('sentry:command', listener);
  },
});
