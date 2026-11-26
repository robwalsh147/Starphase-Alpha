// Starphase Alpha — Windows desktop shell (Electron).
// Serves the game from ./game over a private app:// scheme and manages window modes:
// borderless windowed (default), windowed (custom title bar), fullscreen.

const { app, BrowserWindow, protocol, net, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const GAME_DIR = path.join(__dirname, 'game');
const CFG_FILE = path.join(app.getPath('userData'), 'display.json');

let cfg = { displayMode: 'borderless', unlockFps: false, windowBounds: null };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch { /* first run */ }
const saveCfg = () => { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); } catch { /* ignore */ } };

// Render beyond the monitor's refresh rate (opt-in from Settings, needs a restart).
if (cfg.unlockFps) {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}
app.commandLine.appendSwitch('enable-gpu-rasterization');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win;

function applyMode(mode) {
  if (!win) return;
  if (mode !== 'fullscreen' && win.isFullScreen()) {
    win.once('leave-full-screen', () => applyMode(mode));
    win.setFullScreen(false);
    return;
  }
  const display = screen.getDisplayMatching(win.getBounds());
  if (mode === 'fullscreen') {
    win.setResizable(true);
    win.setFullScreen(true);
  } else if (mode === 'borderless') {
    win.setResizable(false);
    win.setBounds(display.bounds);
  } else {
    win.setResizable(true);
    const wa = display.workArea;
    const b = cfg.windowBounds || {
      width: Math.min(1600, wa.width - 80), height: Math.min(900, wa.height - 80),
      x: 0, y: 0,
    };
    if (!cfg.windowBounds) { b.x = wa.x + Math.round((wa.width - b.width) / 2); b.y = wa.y + Math.round((wa.height - b.height) / 2); }
    win.setBounds(b);
  }
  win.webContents.send('display-mode', mode);
}

function createWindow() {
  win = new BrowserWindow({
    title: 'Starphase Alpha',
    icon: path.join(__dirname, 'icon.ico'),
    frame: false,
    show: false,
    backgroundColor: '#000000',
    width: 1600, height: 900, minWidth: 960, minHeight: 540,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  win.loadURL('app://game/index.html');
  win.once('ready-to-show', () => { applyMode(cfg.displayMode); win.show(); win.focus(); });
  win.webContents.on('did-finish-load', () => win.webContents.send('display-mode', cfg.displayMode));

  const rememberBounds = () => {
    if (cfg.displayMode === 'windowed' && !win.isFullScreen() && !win.isMaximized()) { cfg.windowBounds = win.getBounds(); saveCfg(); }
  };
  win.on('resized', rememberBounds);
  win.on('moved', rememberBounds);

  // Never navigate away from the game or open popups.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // F11 toggles fullscreen <-> previous mode.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) {
      e.preventDefault();
      win.webContents.reloadIgnoringCache();
      return;
    }
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      setMode(cfg.displayMode === 'fullscreen' ? (cfg.lastNonFullscreen || 'borderless') : 'fullscreen');
    }
  });
}

function setMode(mode) {
  if (!['borderless', 'windowed', 'fullscreen'].includes(mode) || mode === cfg.displayMode) return;
  if (mode === 'fullscreen') cfg.lastNonFullscreen = cfg.displayMode;
  cfg.displayMode = mode;
  saveCfg();
  applyMode(mode);
}

// ---------------------------------------------------------------------------
// Game-content updates from the website (the Electron shell itself stays as installed).
// ---------------------------------------------------------------------------
const SITE = 'https://robwalsh147.github.io/Starphase-Alpha/';
const readLocalVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(GAME_DIR, 'version.json'), 'utf8')); } catch { return null; } };

ipcMain.handle('check-update', async () => {
  const local = readLocalVersion();
  try {
    const r = await net.fetch(`${SITE}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return { local, remote: null };
    return { local, remote: await r.json() };
  } catch { return { local, remote: null }; }
});

ipcMain.handle('apply-update', async (_e) => {
  const list = await (await net.fetch(`${SITE}manifest.json?t=${Date.now()}`, { cache: 'no-store' })).json();
  if (!Array.isArray(list) || !list.includes('index.html')) throw new Error('bad manifest');
  const staging = GAME_DIR + '.new', old = GAME_DIR + '.old';
  fs.rmSync(staging, { recursive: true, force: true });
  let done = 0;
  // download in small parallel batches into a staging folder; only swap once everything arrived
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async (rel) => {
      const dest = path.normalize(path.join(staging, rel));
      if (!dest.startsWith(staging + path.sep) || rel.includes('..')) throw new Error(`bad path ${rel}`);
      const res = await net.fetch(SITE + rel.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' });
      if (!res.ok) throw new Error(`${rel}: ${res.status}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      done++;
      win?.webContents.send('update-progress', done / list.length);
    }));
  }
  fs.rmSync(old, { recursive: true, force: true });
  try {
    fs.renameSync(GAME_DIR, old);
    fs.renameSync(staging, GAME_DIR);
  } catch {
    // a file was still open (Windows): copy over the top instead
    if (!fs.existsSync(GAME_DIR) && fs.existsSync(old)) fs.renameSync(old, GAME_DIR);
    fs.cpSync(staging, GAME_DIR, { recursive: true, force: true });
  }
  fs.rmSync(old, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
  setTimeout(() => win?.webContents.reloadIgnoringCache(), 300);
  return true;
});

ipcMain.on('get-display-mode', (e) => { e.returnValue = cfg.displayMode; });
ipcMain.on('set-display-mode', (_e, mode) => setMode(mode));
ipcMain.on('set-unlock-fps', (_e, v) => { cfg.unlockFps = !!v; saveCfg(); });
ipcMain.on('win-min', () => win?.minimize());
ipcMain.on('win-max', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win-close', () => win?.close());

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(GAME_DIR, rel));
    if (!file.startsWith(GAME_DIR)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString()).then((r) => new Response(r.body, {
      status: r.status,
      // no-cache so synced updates show up on the next reload
      headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-cache' },
    }));
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
