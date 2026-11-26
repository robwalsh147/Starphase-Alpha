// Bridge between the game page and the desktop shell. Exposes only what the game needs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('starphase', {
  isDesktop: true,
  getDisplayMode: () => ipcRenderer.sendSync('get-display-mode'),
  setDisplayMode: (mode) => ipcRenderer.send('set-display-mode', mode),
  setUnlockFps: (on) => ipcRenderer.send('set-unlock-fps', !!on),
  windowControl: (action) => ipcRenderer.send(`win-${action}`),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  onUpdateProgress: (fn) => ipcRenderer.on('update-progress', (_e, f) => fn(f)),
});

// Show the custom title bar only in windowed mode.
ipcRenderer.on('display-mode', (_e, mode) => {
  const apply = () => {
    document.body.classList.toggle('windowed', mode === 'windowed');
    window.dispatchEvent(new Event('resize'));
  };
  if (document.body) apply(); else window.addEventListener('DOMContentLoaded', apply, { once: true });
});
