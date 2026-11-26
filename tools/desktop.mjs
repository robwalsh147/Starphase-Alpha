// Desktop build + install + update for Starphase Alpha (Windows).
//
//   node tools/desktop.mjs package   full build: stage -> package exe (with icon) -> install -> Desktop shortcut
//   node tools/desktop.mjs sync      fast update: copy current game files into the installed app
//   node tools/desktop.mjs zip       also produce downloads/StarphaseAlpha-win64.zip for the browser download button
//   node tools/desktop.mjs ci        build + zip only (used by the GitHub release workflow)
//
// Install location: %LOCALAPPDATA%\Programs\Starphase Alpha   (per-user, no admin needed)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'desktop', 'app');
const DIST = path.join(ROOT, 'dist');
const APP_NAME = 'Starphase Alpha';
const INSTALL = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', APP_NAME);
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.1.0';

const cp = (from, to) => fs.cpSync(path.join(ROOT, from), to, { recursive: true, force: true });

// Game files the desktop app needs (kept at the same relative paths as the browser build).
const GAME_FILES = [
  'index.html', 'style.css', 'src', 'assets',
  'node_modules/three/build/three.module.js',
  'node_modules/three/examples/jsm',
  'node_modules/@fontsource/syncopate',
  'node_modules/@fontsource/orbitron',
];

// Build id = current git commit (matches the website's version.json for the same commit).
function buildInfo() {
  let build = 'dev';
  try { build = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch { /* not a git checkout */ }
  return { build, version, date: new Date().toISOString() };
}

function stageGame(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const f of GAME_FILES) cp(f, path.join(dest, f));
  fs.copyFileSync(path.join(ROOT, 'build', 'icon-256.png'), path.join(dest, 'icon.png'));
  fs.writeFileSync(path.join(dest, 'version.json'), JSON.stringify(buildInfo()));
}

function stage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const f of ['main.cjs', 'preload.cjs']) fs.copyFileSync(path.join(ROOT, 'desktop', f), path.join(STAGE, f));
  fs.copyFileSync(path.join(ROOT, 'build', 'icon.ico'), path.join(STAGE, 'icon.ico'));
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
    name: 'starphase-alpha', productName: APP_NAME, version, main: 'main.cjs', description: 'Starphase Alpha',
  }, null, 2));
  stageGame(path.join(STAGE, 'game'));
}

function desktopDir() {
  return execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"]).toString().trim();
}

function makeShortcut() {
  const exe = path.join(INSTALL, `${APP_NAME}.exe`);
  const lnk = path.join(desktopDir(), `${APP_NAME}.lnk`);
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');` +
    `$s.TargetPath='${exe.replace(/'/g, "''")}';$s.WorkingDirectory='${INSTALL.replace(/'/g, "''")}';` +
    `$s.IconLocation='${exe.replace(/'/g, "''")},0';$s.Description='Starphase Alpha';$s.Save()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps]);
  console.log('Desktop shortcut:', lnk);
}

function assertNotRunning() {
  const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${APP_NAME}.exe`, '/NH']).toString();
  if (out.includes(`${APP_NAME}.exe`)) {
    console.error(`\n${APP_NAME} is running — close it first, then re-run this command.\n`);
    process.exit(2);
  }
}

async function buildPackage() {
  stage();
  const { packager } = await import('@electron/packager');
  const [outDir] = await packager({
    dir: STAGE, out: DIST, overwrite: true, platform: 'win32', arch: 'x64',
    name: APP_NAME, executableName: APP_NAME, icon: path.join(ROOT, 'build', 'icon.ico'),
    asar: false, prune: false, appVersion: version,
    win32metadata: { CompanyName: 'Starphase', FileDescription: APP_NAME, ProductName: APP_NAME, InternalName: APP_NAME },
  });
  return outDir;
}

async function packageApp() {
  assertNotRunning();
  const outDir = await buildPackage();
  fs.rmSync(INSTALL, { recursive: true, force: true });
  fs.cpSync(outDir, INSTALL, { recursive: true });
  console.log('Installed to:', INSTALL);
  makeShortcut();
  return outDir;
}

function sync() {
  const appDir = path.join(INSTALL, 'resources', 'app');
  if (!fs.existsSync(appDir)) { console.error('Not installed yet — run: node tools/desktop.mjs package'); process.exit(1); }
  stageGame(path.join(appDir, 'game'));
  for (const f of ['main.cjs', 'preload.cjs']) fs.copyFileSync(path.join(ROOT, 'desktop', f), path.join(appDir, f));
  console.log(`Synced game files to ${appDir} — restart the app (or press Ctrl+R) to see changes.`);
}

function zip(outDir) {
  const src = outDir || path.join(DIST, `${APP_NAME}-win32-x64`);
  fs.mkdirSync(path.join(ROOT, 'downloads'), { recursive: true });
  const dest = path.join(ROOT, 'downloads', 'StarphaseAlpha-win64.zip');
  fs.rmSync(dest, { force: true });
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${src}\\*' -DestinationPath '${dest}' -CompressionLevel Optimal`], { stdio: 'inherit' });
  console.log('Download zip:', dest);
}

const cmd = process.argv[2] || 'sync';
if (cmd === 'package') await packageApp();
else if (cmd === 'sync') sync();
else if (cmd === 'zip') zip();
else if (cmd === 'ci') zip(await buildPackage()); // CI: build + zip only, no install/shortcut
else { console.log('usage: node tools/desktop.mjs [package|sync|zip|ci]'); process.exit(1); }
