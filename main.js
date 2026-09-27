// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const scan = require('./core/scan');
const install = require('./core/install');
const runtimes = require('./core/runtimes');
const authenticode = require('./core/authenticode');
const anticheat = require('./core/anticheat');
const logreport = require('./core/logreport');
const covers = require('./core/covers');
const artwork = require('./core/artwork');
const profiles = require('./core/profiles');
const activity = require('./core/activity');
const media = require('./core/media');
const mediarun = require('./core/mediarun');
const updates = require('./core/update');

// Pictures and videos are shown to the page through this scheme, one token per
// file the user picked or a job wrote - never an arbitrary path.
protocol.registerSchemesAsPrivileged([
  { scheme: 'aio-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const APP_ROOT = __dirname;

// APP_ROOT is read-only ground: the payload and any bundled runtimes live there.
// Everything the app WRITES - settings, per-game profiles, downloaded cover art - goes to
// DATA_ROOT, and where that is depends on how the app was started:
//
//   from source      -> beside the project, so a checkout keeps its own state
//   portable .exe    -> beside the .exe the user double-clicked. A portable build unpacks
//                       itself into a temp folder and deletes it afterwards, so writing
//                       "next to the app" would silently bin every setting on each run;
//                       electron-builder hands us the real location in PORTABLE_EXECUTABLE_DIR.
//   installed        -> the per-user app-data folder, because Program Files is not writable
//                       by a normal user.
// The probe is a real write: on Windows an access check on a directory can succeed where an
// actual write is refused.
function canWrite(dir) {
  const probe = path.join(dir, '.write-probe');
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveDataRoot() {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable && canWrite(portable)) return portable;
  if (app.isPackaged) return app.getPath('userData');
  return canWrite(APP_ROOT) ? APP_ROOT : app.getPath('userData');
}
const DATA_ROOT = resolveDataRoot();
const COVERS_DIR = path.join(DATA_ROOT, 'covers');
const BUILD = '2.2.4-revin10b';

const log = activity.create();
const art = artwork.create({ cacheDir: COVERS_DIR, log: message => log.info(message) });

let window_ = null;

const THEME_BACKGROUND = { dark: '#07090d', light: '#eef1f4' };

function createWindow() {
  const settings = profiles.readSettings(DATA_ROOT);
  window_ = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: THEME_BACKGROUND[settings.theme] || THEME_BACKGROUND.dark,
    title: 'DLSS 5 AIO Installer',
    // The page draws its own title bar and window buttons, so the frame comes off.
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window_.removeMenu();
  window_.loadFile(path.join('ui', 'index.html'));
  window_.once('ready-to-show', () => window_.show());
  window_.on('maximize', () => send('window:state', { maximized: true }));
  window_.on('unmaximize', () => send('window:state', { maximized: false }));
}

function send(channel, payload) {
  if (window_ && !window_.isDestroyed()) window_.webContents.send(channel, payload);
}

app.whenReady().then(() => {
  protocol.handle('aio-media', serveMedia);
  createWindow();
  // Self-identifying, so a log pasted from anywhere says exactly which build wrote it.
  let payloadSha = 'unreadable';
  try { payloadSha = runtimes.sha256(path.join(APP_ROOT, 'payload', 'standalone-dlssnr.addon64')).slice(0, 16); } catch { /* reported as unreadable */ }
  log.info(`DLSS 5 AIO Installer ${app.getVersion()} by Revin (revingale32) started - add-on build ${BUILD}, payload sha256 ${payloadSha}…, ${process.platform} ${process.arch}`);
  log.onEntry(entry => send('activity:entry', entry));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // Only with the user's yes (asked once in the app, changeable in Settings).
  if (updates.checkOnStart(profiles.readSettings(DATA_ROOT))) setTimeout(() => checkForUpdate('start'), 5000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { runner.stopAll(); });

// ---------------------------------------------------------------- IPC
//
// Every handler is a thin wrapper over the tested core. Nothing decides
// anything here that the CLI does not also decide, so the two can never drift.

function fail(error) {
  return { ok: false, error: String(error && error.message || error), code: error && error.code };
}

function slimExe(exe) {
  return exe ? {
    name: exe.name, api: exe.api, apiSource: exe.apiSource, bitness: exe.bitness,
    renders: exe.renders, canonical: exe.canonical || null,
  } : null;
}

ipcMain.handle('library:list', async () => {
  try {
    const manual = profiles.readManualGames(DATA_ROOT);
    const scanned = scan.scanAll();
    const games = [...scanned, ...manual];
    const seen = new Set();
    const rows = [];
    for (const game of games) {
      if (seen.has(game.dir.toLowerCase())) continue;
      seen.add(game.dir.toLowerCase());
      const { chosen } = scan.chooseExecutable(game.dir);
      const cheat = anticheat.detect(game.dir);
      const state = install.status(game.dir);
      rows.push({
        id: game.id,
        name: game.name,
        store: game.store,
        appid: game.appid || null,
        dir: game.dir,
        exe: slimExe(chosen),
        anticheat: cheat.systems,
        installed: state.installed,
        managed: state.managed,
        route: state.route || install.routeFor(chosen, game.dir),
        installedAt: state.installedAt,
        installedBuild: state.build,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const stores = ['Steam', 'Xbox', 'Manual'].map(store => `${rows.filter(r => r.store === store).length} ${store}`).join(', ');
    log.info(`Found ${rows.length} games (${stores}); ${rows.filter(r => r.installed).length} with the add-on installed`);
    return { ok: true, games: rows };
  } catch (error) { log.error(`Scan failed: ${error.message}`); return fail(error); }
});

ipcMain.handle('game:plan', async (_event, { dir, exeName, profile }) => {
  try {
    const { chosen, candidates } = scan.chooseExecutable(dir);
    const exe = exeName ? candidates.find(c => c.name.toLowerCase() === exeName.toLowerCase()) || chosen : chosen;
    const saved = profiles.readProfile(DATA_ROOT, dir);
    const planned = install.plan({ dir, exe }, {
      appRoot: APP_ROOT,
      profile: { ...saved, ...(profile || {}) },
      extraRuntimeDirs: profiles.readRuntimeDirs(DATA_ROOT),
      runtimeGames: scan.scanAll(),
      allowUnknownNeural: profiles.readSettings(DATA_ROOT).allowUnknownRuntime === true,
    });
    return {
      ok: true,
      plan: {
        gameDir: planned.gameDir,
        route: planned.route,
        hook: planned.hook,
        exe: slimExe(planned.exe),
        candidates: candidates.map(c => ({ ...slimExe(c), demoted: c.demoted })),
        files: [
          ...planned.files.map(f => ({ to: f.to, role: f.role, outsideGame: Boolean(f.outsideGame), shared: Boolean(f.shared), action: f.action || 'copy', from: f.action === 'park' ? f.from : undefined })),
          ...(planned.iniEdits || []).map(e => ({ to: e.file, role: e.role, outsideGame: false, shared: false, action: 'ini' })),
        ],
        profile: planned.profile,
        problems: planned.problems,
        notes: planned.notes,
        installable: planned.installable,
        alreadyInstalled: planned.alreadyInstalled,
        managed: planned.current.managed,
        installedBuild: planned.current.build,
        installedAt: planned.current.installedAt,
        backupDir: planned.current.backupDir,
        runtime: planned.runtimes.nr ? { from: planned.runtimes.nr.from, bytes: planned.runtimes.nr.bytes, sha: planned.runtimes.nr.sha || null, version: planned.runtimes.nr.version || null, known: planned.runtimes.nr.known === true } : null,
        runtimeCheck: planned.runtimeCheck ? { ok: planned.runtimeCheck.ok, details: planned.runtimeCheck.details } : null,
        intact: planned.current.intact !== false,
        changedSinceInstall: planned.current.changedSinceInstall || [],
        verifySummary: planned.current.verifySummary || null,
        anticheat: planned.anticheat.systems,
        anticheatWarning: planned.anticheat.present ? anticheat.warning(planned.anticheat) : null,
        build: BUILD,
        machine: {
          gpu: planned.machine.gpu,
          hags: planned.machine.hags,
          verdicts: planned.machine.verdicts,
          runtimes: Object.fromEntries(Object.entries(planned.machine.runtimes).map(([kind, info]) =>
            [kind, { fileVersion: info.fileVersion, minArchitectureName: info.minArchitectureName }])),
        },
      },
    };
  } catch (error) { return fail(error); }
});

ipcMain.handle('game:install', async (_event, { dir, exeName, profile, acknowledgedAntiCheat }) => {
  try {
    const { chosen, candidates } = scan.chooseExecutable(dir);
    const exe = exeName ? candidates.find(c => c.name.toLowerCase() === exeName.toLowerCase()) || chosen : chosen;
    const planned = install.plan({ dir, exe }, {
      appRoot: APP_ROOT,
      profile: profile || profiles.readProfile(DATA_ROOT, dir),
      extraRuntimeDirs: profiles.readRuntimeDirs(DATA_ROOT),
      runtimeGames: scan.scanAll(),
      allowUnknownNeural: profiles.readSettings(DATA_ROOT).allowUnknownRuntime === true,
    });
    const manifest = install.apply(planned, { acknowledgedAntiCheat: acknowledgedAntiCheat === true, appRoot: APP_ROOT });
    profiles.writeProfile(DATA_ROOT, dir, planned.profile);
    log.info(`Installed build ${manifest.build} into ${path.basename(dir)} via the ${manifest.route === 'relay' ? 'neural relay' : manifest.route === 'optiscaler' ? 'OptiScaler' : 'game'} route (${manifest.files.length} files, originals backed up)`);
    return { ok: true, manifest };
  } catch (error) {
    log.error(`Install into ${path.basename(String(dir))} failed: ${error.message}`);
    return fail(error);
  }
});

ipcMain.handle('game:restore', async (_event, { dir, force }) => {
  try {
    const result = install.restore(dir, { force: force === true });
    log.info(`Restored ${path.basename(dir)}: ${result.restored.length} original(s) back, ${result.removed.length} file(s) removed`
      + (result.left && result.left.length ? `, ${result.left.length} machine-wide file(s) left for other games` : '')
      + (result.skipped && result.skipped.length ? `, ${result.skipped.length} changed-since-install file(s) left alone` : '')
      + (result.failures.length ? `, ${result.failures.length} problem(s)` : ''));
    return { ok: true, result };
  } catch (error) { log.error(`Restore of ${path.basename(String(dir))} failed: ${error.message}`); return fail(error); }
});

ipcMain.handle('game:status', async (_event, { dir }) => {
  try {
    return { ok: true, manifest: install.readManifest(dir), history: install.history(dir) };
  } catch (error) { return fail(error); }
});

ipcMain.handle('game:verify', async (_event, { dir }) => {
  try {
    const check = install.verify(dir);
    if (check.gameUpdated) log.warn(`${path.basename(dir)}: ${check.summary}`);
    return { ok: true, check };
  } catch (error) { return fail(error); }
});

ipcMain.handle('runtimes:locate', async () => {
  try {
    const found = runtimes.locate({
      appRoot: APP_ROOT,
      extraDirs: profiles.readRuntimeDirs(DATA_ROOT),
      games: scan.scanAll(),
    });
    const machine = install.inspectMachine({
      nr: found.nr ? found.nr.file : null, sr: found.sr ? found.sr.file : null, fg: found.fg ? found.fg.file : null,
    });
    const state = runtimes.describe(found);
    const check = state.ok ? runtimes.verify(found, { allowUnknownNeural: true }) : null;
    const files = Object.fromEntries(Object.keys(runtimes.WANTED).map(kind => {
      const hit = found[kind];
      if (!hit) return [kind, null];
      const detail = check && check.details[kind];
      const sig = authenticode.signature(hit.file);
      return [kind, { ...hit, sha: detail ? detail.sha : null, version: detail ? detail.version : null, known: detail ? detail.known : false,
        signature: { ...sig, ...authenticode.describe(sig) } }];
    }));
    return {
      ok: true,
      searched: found.searched,
      files,
      state,
      validated: check ? { neuralKnown: Boolean(check.details.nr && check.details.nr.known), notes: check.notes.filter(n => !/^Allowed by your setting/.test(n)) } : null,
      allowUnknownRuntime: profiles.readSettings(DATA_ROOT).allowUnknownRuntime === true,
      extraDirs: profiles.readRuntimeDirs(DATA_ROOT),
      machine,
    };
  } catch (error) { return fail(error); }
});

ipcMain.handle('runtimes:browse', async () => {
  try {
    const picked = await dialog.showOpenDialog(window_, {
      title: 'Choose a folder that has nvngx_dlssnr.dll',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: true, added: null };
    const dir = picked.filePaths[0];
    const found = runtimes.inspectDir(dir);
    if (!found.nr) return { ok: false, error: 'That folder has no nvngx_dlssnr.dll in it.' };
    profiles.addRuntimeDir(DATA_ROOT, dir);
    log.info(`Runtime folder added: ${dir}`);
    return { ok: true, added: dir, found: Object.keys(found) };
  } catch (error) { return fail(error); }
});

ipcMain.handle('runtimes:forget', async (_event, { dir }) => {
  try { profiles.removeRuntimeDir(DATA_ROOT, dir); return { ok: true }; } catch (error) { return fail(error); }
});

function addManualFolder(dir) {
  const game = { id: `manual:${dir}`, store: 'Manual', name: path.basename(dir), dir };
  profiles.addManualGame(DATA_ROOT, game);
  log.info(`Folder added: ${dir}`);
  return game;
}

ipcMain.handle('library:addFolder', async () => {
  try {
    const picked = await dialog.showOpenDialog(window_, {
      title: 'Choose the folder that holds the game executable',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: true, added: null };
    const game = addManualFolder(picked.filePaths[0]);
    return { ok: true, added: game.dir, game };
  } catch (error) { return fail(error); }
});

// A folder - or an executable - dropped onto the window. The path comes from
// the preload's webUtils, never from page text.
ipcMain.handle('library:addFolderPath', async (_event, { file }) => {
  try {
    if (!file || typeof file !== 'string') return { ok: false, error: 'Nothing droppable was found.' };
    let dir = file;
    const stat = fs.statSync(file);
    if (!stat.isDirectory()) dir = path.dirname(file);
    const game = addManualFolder(dir);
    return { ok: true, added: game.dir, game };
  } catch (error) { return fail(error); }
});

ipcMain.handle('library:forget', async (_event, { dir }) => {
  try { profiles.removeManualGame(DATA_ROOT, dir); log.info(`Folder forgotten: ${dir}`); return { ok: true }; } catch (error) { return fail(error); }
});

ipcMain.handle('log:read', async (_event, { file } = {}) => {
  try {
    const target = file || logreport.defaultLogFile();
    if (!target || !fs.existsSync(target)) return { ok: false, error: `No log found at ${target || 'the default location'}.` };
    return { ok: true, file: target, reports: logreport.read(target) };
  } catch (error) { return fail(error); }
});

// ---------------------------------------------------------------- pictures, videos, desktop

const MEDIA_DIR = path.join(DATA_ROOT, 'media');
const allowedMedia = new Map();     // lower-cased path -> real path: files the user chose or a job wrote
const mediaTokens = new Map();      // token -> real path
let jobCounter = 0;
let runtimeCache = null;            // { key, at, found, check }

function allowMedia(file) {
  if (typeof file === 'string' && file) allowedMedia.set(path.resolve(file).toLowerCase(), path.resolve(file));
}
function isAllowedMedia(file) {
  return typeof file === 'string' && allowedMedia.has(path.resolve(file).toLowerCase());
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};

async function serveMedia(request) {
  try {
    const token = new URL(request.url).hostname;
    const file = mediaTokens.get(token);
    if (!file) return new Response('Not found', { status: 404 });
    const stat = await fs.promises.stat(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = request.headers.get('range');
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = Math.min(match && match[2] ? Number(match[2]) : stat.size - 1, stat.size - 1);
      if (!match || start > end || start >= stat.size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes' },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      status: 200, headers: { 'Content-Type': type, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' },
    });
  } catch (error) {
    return new Response(String(error.message || error), { status: 500 });
  }
}

function readMediaSettings() {
  return media.settingsFromState(profiles.read(DATA_ROOT));
}
function writeMediaSettings(patch) {
  const state = profiles.read(DATA_ROOT);
  const next = media.normalize({ ...media.normalize(state.media), ...(patch || {}) });
  state.media = next;
  profiles.write(DATA_ROOT, state);
  return next;
}

// The neural runtime for the worker: located and hash-checked exactly as for
// installs. Hashing a 158 MB file takes a moment, so the answer is kept while
// the file is unchanged.
function mediaRuntime() {
  const found = runtimes.locate({ appRoot: APP_ROOT, extraDirs: profiles.readRuntimeDirs(DATA_ROOT), games: scan.scanAll() });
  let key = 'none';
  if (found.nr) {
    try { const stat = fs.statSync(found.nr.file); key = `${found.nr.file}|${stat.size}|${stat.mtimeMs}`; } catch { key = found.nr.file; }
  }
  let check;
  if (runtimeCache && runtimeCache.key === key) check = runtimeCache.check;
  else {
    check = found.nr ? runtimes.verify({ nr: found.nr }, { allowUnknownNeural: true }) : null;
    runtimeCache = { key, check };
  }
  return media.resolveRuntime(found, check, { allowUnknownNeural: profiles.readSettings(DATA_ROOT).allowUnknownRuntime === true });
}

function describeFiles(paths) {
  const out = [];
  for (const file of paths) {
    if (typeof file !== 'string' || !file) continue;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(file); } catch { names = []; }
      for (const name of names) {
        const full = path.join(file, name);
        const kind = media.classify(full);
        if (!kind) continue;
        try { const inner = fs.statSync(full); if (inner.isFile()) { allowMedia(full); out.push({ source: full, name, kind, bytes: inner.size }); } } catch { /* skip */ }
      }
      continue;
    }
    const kind = media.classify(file);
    if (!kind || !stat.isFile()) continue;
    allowMedia(file);
    out.push({ source: file, name: path.basename(file), kind, bytes: stat.size });
  }
  return out;
}

const runner = mediarun.createRunner({
  spawn,
  log: message => log.info(message),
  onEvent: event => {
    if (event.event === 'file-done' && event.output) allowMedia(event.output);
    const line = media.describeEvent(event);
    if (line) {
      if (event.event === 'error' || event.event === 'file-error' || event.event === 'crash') log.error(`Media: ${line}`);
      else if (event.event === 'warning') log.warn(`Media: ${line}`);
      else log.info(`Media: ${line}`);
    }
    send('media:event', event);
  },
});

function workerReady() {
  const exe = media.workerPath(APP_ROOT);
  const bridge = media.bridgePath(APP_ROOT);
  if (!fs.existsSync(exe)) return { ok: false, message: 'payload\\media\\dlss5-media.exe is missing from this install - reinstall the AIO Installer.' };
  if (!fs.existsSync(bridge)) return { ok: false, message: 'payload\\nvngx.dll (the caller bridge) is missing from this install - reinstall the AIO Installer.' };
  return { ok: true, exe, bridge };
}

ipcMain.handle('media:readiness', async () => {
  try {
    const worker = workerReady();
    const runtime = mediaRuntime();
    return { ok: true, worker, runtime, running: runner.status(), mediaLog: path.join(MEDIA_DIR, 'dlss5-media.log') };
  } catch (error) { return fail(error); }
});

ipcMain.handle('media:getSettings', async () => ({ ok: true, settings: readMediaSettings(), defaults: media.DEFAULTS, workSizes: media.WORK_SIZES }));

ipcMain.handle('media:setSettings', async (_event, patch) => {
  try { return { ok: true, settings: writeMediaSettings(patch) }; } catch (error) { return fail(error); }
});

ipcMain.handle('media:pickFiles', async () => {
  try {
    const picked = await dialog.showOpenDialog(window_, {
      title: 'Choose pictures or videos',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Pictures and videos', extensions: [...media.IMAGE_EXTENSIONS, ...media.VIDEO_EXTENSIONS].map(ext => ext.slice(1)) },
        { name: 'Pictures', extensions: media.IMAGE_EXTENSIONS.map(ext => ext.slice(1)) },
        { name: 'Videos', extensions: media.VIDEO_EXTENSIONS.map(ext => ext.slice(1)) },
      ],
    });
    if (picked.canceled) return { ok: true, files: [] };
    return { ok: true, files: describeFiles(picked.filePaths) };
  } catch (error) { return fail(error); }
});

ipcMain.handle('media:addPaths', async (_event, { paths } = {}) => {
  try { return { ok: true, files: describeFiles(Array.isArray(paths) ? paths : []) }; } catch (error) { return fail(error); }
});

ipcMain.handle('media:pickOutputDir', async () => {
  try {
    const picked = await dialog.showOpenDialog(window_, { title: 'Choose where the results go', properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths.length) return { ok: true, dir: null };
    const settings = writeMediaSettings({ outputDir: picked.filePaths[0] });
    return { ok: true, dir: picked.filePaths[0], settings };
  } catch (error) { return fail(error); }
});

ipcMain.handle('media:start', async (_event, { mode, files, settings } = {}) => {
  try {
    if (mode !== 'image' && mode !== 'video') return { ok: false, error: 'Unknown kind of job.' };
    if (runner.isRunning('job')) return { ok: false, error: 'A job is already running.' };
    const worker = workerReady();
    if (!worker.ok) return { ok: false, error: worker.message };
    const runtime = mediaRuntime();
    if (!runtime.ok) return { ok: false, error: runtime.message };
    const s = writeMediaSettings(settings || {});
    if (s.outputDir) fs.mkdirSync(s.outputDir, { recursive: true });
    const taken = new Set();
    const items = [];
    for (const file of Array.isArray(files) ? files : []) {
      if (!isAllowedMedia(file) || media.classify(file) !== mode) continue;
      items.push({ input: file, output: media.outputPathFor(file, mode, s, taken) });
    }
    if (!items.length) return { ok: false, error: 'Nothing to process.' };
    jobCounter += 1;
    const id = jobCounter;
    const list = media.writeList(path.join(MEDIA_DIR, `job-${id}.txt`), items);
    const args = media.buildArgs(mode, s, { nr: runtime.nr, bridge: worker.bridge, list, log: path.join(MEDIA_DIR, 'dlss5-media.log') });
    items.forEach(item => allowMedia(item.output));
    const started = runner.start('job', worker.exe, args, { id, mode });
    if (!started.ok) return { ok: false, error: started.error };
    log.info(`${mode === 'image' ? 'Pictures' : 'Videos'}: ${items.length} file(s) started through DLSS 5 neural rendering`
      + ` (style ${s.style}, ${s.passes} pass${s.passes === 1 ? '' : 'es'}, strength ${Math.round(s.mix * 100)}%)`);
    return { ok: true, job: id, items };
  } catch (error) { log.error(`Media job failed to start: ${error.message}`); return fail(error); }
});

ipcMain.handle('media:cancel', async () => {
  try { return runner.stop('job'); } catch (error) { return fail(error); }
});

ipcMain.handle('media:probe', async (_event, { settings } = {}) => {
  try {
    const worker = workerReady();
    if (!worker.ok) return { ok: false, error: worker.message };
    const runtime = mediaRuntime();
    if (!runtime.ok) return { ok: false, error: runtime.message };
    const args = media.buildArgs('probe', media.normalize({ ...readMediaSettings(), ...(settings || {}) }),
      { nr: runtime.nr, bridge: worker.bridge, log: path.join(MEDIA_DIR, 'dlss5-media.log') });
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const result = await mediarun.runOnce(spawn, worker.exe, args, { timeoutMs: 90000 });
    const probe = result.events.find(event => event.event === 'probe') || null;
    const ready = result.events.find(event => event.event === 'ready') || null;
    const errors = result.events.filter(event => event.event === 'error' || event.event === 'crash').map(event => event.message || `crash ${event.code}`);
    if (probe) log.info(`Media: ${media.describeEvent(probe)}`);
    errors.forEach(message => log.error(`Media probe: ${message}`));
    return { ok: Boolean(probe && probe.ok), code: result.code, probe, ready, errors };
  } catch (error) { return fail(error); }
});

ipcMain.handle('media:monitors', async () => {
  try {
    const worker = workerReady();
    if (!worker.ok) return { ok: false, error: worker.message };
    const result = await mediarun.runOnce(spawn, worker.exe, media.buildArgs('monitors', {}), { timeoutMs: 20000 });
    return { ok: result.code === 0, monitors: result.events.filter(event => event.event === 'monitor'),
      errors: result.events.filter(event => event.event === 'error').map(event => event.message) };
  } catch (error) { return fail(error); }
});

ipcMain.handle('media:preview', async (_event, { file } = {}) => {
  try {
    if (!isAllowedMedia(file) || !fs.existsSync(file)) return { ok: false, error: 'Not a file from this session.' };
    const real = allowedMedia.get(path.resolve(file).toLowerCase());
    let token = null;
    for (const [key, value] of mediaTokens) if (value === real) { token = key; break; }
    if (!token) { token = crypto.randomBytes(12).toString('hex'); mediaTokens.set(token, real); }
    return { ok: true, url: `aio-media://${token}/${encodeURIComponent(path.basename(real))}`, bytes: fs.statSync(real).size };
  } catch (error) { return fail(error); }
});

ipcMain.handle('media:reveal', async (_event, { file } = {}) => {
  try {
    if (file === 'log') { fs.mkdirSync(MEDIA_DIR, { recursive: true }); shell.showItemInFolder(path.join(MEDIA_DIR, 'dlss5-media.log')); return { ok: true }; }
    if (!isAllowedMedia(file)) return { ok: false, error: 'Not a file from this session.' };
    shell.showItemInFolder(file);
    return { ok: true };
  } catch (error) { return fail(error); }
});

ipcMain.handle('media:open', async (_event, { file } = {}) => {
  try {
    if (!isAllowedMedia(file)) return { ok: false, error: 'Not a file from this session.' };
    const outcome = await shell.openPath(file);
    return outcome ? { ok: false, error: outcome } : { ok: true };
  } catch (error) { return fail(error); }
});

ipcMain.handle('desktop:start', async (_event, { settings } = {}) => {
  try {
    if (runner.isRunning('desktop')) return { ok: false, error: 'Desktop mode is already running.' };
    const worker = workerReady();
    if (!worker.ok) return { ok: false, error: worker.message };
    const runtime = mediaRuntime();
    if (!runtime.ok) return { ok: false, error: runtime.message };
    const s = writeMediaSettings(settings || {});
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const args = media.buildArgs('desktop', s, { nr: runtime.nr, bridge: worker.bridge, log: path.join(MEDIA_DIR, 'dlss5-media.log') });
    const started = runner.start('desktop', worker.exe, args, { id: 'desktop', mode: 'desktop' });
    if (!started.ok) return { ok: false, error: started.error };
    log.info(`Desktop mode starting (style ${s.style}, ${s.passes} pass${s.passes === 1 ? '' : 'es'}, ${s.fpsCap ? `${s.fpsCap} fps cap` : 'no fps cap'}${s.split ? ', before/after split' : ''}) - Ctrl+Alt+N hides the effect, Ctrl+Alt+S splits, Ctrl+Alt+End stops`);
    return { ok: true };
  } catch (error) { return fail(error); }
});

ipcMain.handle('desktop:stop', async () => {
  try { return runner.stop('desktop'); } catch (error) { return fail(error); }
});

// While desktop mode runs, the look and the split change live (no restart).
ipcMain.handle('desktop:look', async (_event, { settings } = {}) => {
  try {
    const s = writeMediaSettings(settings || {});
    return { ok: true, sent: runner.command('desktop', media.lookCommand(s)), settings: s };
  } catch (error) { return fail(error); }
});

ipcMain.handle('desktop:split', async (_event, { on } = {}) => {
  try {
    const s = writeMediaSettings({ split: on === true });
    return { ok: true, sent: runner.command('desktop', media.splitCommand(on === true)), settings: s };
  } catch (error) { return fail(error); }
});

// ---------------------------------------------------------------- updates
//
// New versions come from the app's own GitHub releases, through electron-updater:
// it reads latest.yml from the newest release, downloads the Setup and checks
// its SHA-512 before running it. Nothing is asked of GitHub without the user's
// yes (core/update.js holds the rules and the words). A copy run from source
// has no update feed, so there the updater is simply not loaded.

let updater;                         // undefined = not tried yet, null = unavailable
let updateState = { state: 'idle' };

function setUpdate(next) {
  updateState = next;
  send('update:state', updateView());
}

function updateView() {
  const settings = profiles.readSettings(DATA_ROOT);
  const view = { enabled: Boolean(getUpdater()), consent: settings.checkUpdates, current: app.getVersion(), state: updateState };
  return { ...view, bar: updates.bar(view), status: updates.status(view) };
}

function getUpdater() {
  if (updater !== undefined) return updater;
  updater = null;
  if (!app.isPackaged) return updater;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;          // the user presses Update
    autoUpdater.autoInstallOnAppQuit = false;  // and Restart - nothing installs behind their back
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
      info() {}, debug() {},
      warn: message => log.warn(`Updates: ${updates.errorText(message)}`),
      error: message => log.warn(`Updates: ${updates.errorText(message)}`),
    };
    autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => setUpdate({ state: 'none' }));
    autoUpdater.on('update-available', info => {
      log.info(`Update: version ${info.version} is on the official releases page (this is ${app.getVersion()})`);
      setUpdate({ state: 'available', version: info.version });
    });
    autoUpdater.on('download-progress', progress => setUpdate({ state: 'downloading', version: updateState.version, percent: progress.percent }));
    autoUpdater.on('update-downloaded', info => {
      log.info(`Update: version ${info.version} downloaded and its SHA-512 verified - restart to install`);
      setUpdate({ state: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', error => {
      const during = updateState.state === 'downloading' ? 'download' : 'check';
      setUpdate({ state: 'error', during, version: updateState.version, message: updates.errorText(error) });
    });
    updater = autoUpdater;
  } catch (error) {
    log.warn(`Updates are unavailable in this copy: ${error.message}`);
  }
  return updater;
}

function checkForUpdate(reason) {
  const u = getUpdater();
  if (!u) return { ok: false, error: 'Updates come from the installed app - a copy run from source does not check.' };
  if (updateState.state === 'checking' || updateState.state === 'downloading') return { ok: true, busy: true };
  if (updateState.state === 'downloaded') { setUpdate(updateState); return { ok: true, ready: true }; }
  if (reason !== 'start') log.info('Update: checking the official releases page');
  u.checkForUpdates().catch(() => { /* reported through the error event */ });
  return { ok: true };
}

ipcMain.handle('update:get', async () => ({ ok: true, ...updateView() }));

ipcMain.handle('update:consent', async (_event, { allow } = {}) => {
  try {
    profiles.writeSettings(DATA_ROOT, { checkUpdates: allow === true });
    log.info(allow === true ? 'Update checks on - the app looks for a new release when it starts'
      : 'Update checks off - "Check for updates" on the About page still works');
    if (allow === true) checkForUpdate('consent');
    const view = updateView();
    send('update:state', view);
    return { ok: true, ...view };
  } catch (error) { return fail(error); }
});

ipcMain.handle('update:check', async () => {
  try { return checkForUpdate('manual'); } catch (error) { return fail(error); }
});

ipcMain.handle('update:download', async () => {
  try {
    const u = getUpdater();
    if (!u) return { ok: false, error: 'Updates come from the installed app.' };
    if (updateState.state !== 'available' && !(updateState.state === 'error' && updateState.during === 'download')) {
      return { ok: false, error: 'There is no update waiting to be downloaded.' };
    }
    log.info(`Update: downloading version ${updateState.version}`);
    setUpdate({ state: 'downloading', version: updateState.version, percent: 0 });
    u.downloadUpdate().catch(() => { /* reported through the error event */ });
    return { ok: true };
  } catch (error) { return fail(error); }
});

ipcMain.handle('update:install', async () => {
  try {
    const u = getUpdater();
    if (!u || updateState.state !== 'downloaded') return { ok: false, error: 'No downloaded update to install.' };
    log.info(`Update: restarting to install version ${updateState.version}`);
    // Stop anything running first (desktop mode, a render queue), then let the
    // Setup replace the app silently and start the new version.
    runner.stopAll();
    setImmediate(() => u.quitAndInstall(true, true));
    return { ok: true };
  } catch (error) { return fail(error); }
});

// ---------------------------------------------------------------- artwork

// Cover art crosses as data URLs: the page has no filesystem, and the CSP
// already allows data: images. Disk first; the network only when the setting
// allows it and only for what is missing. One fetch per game at a time, so a
// tile and the sheet asking together do not search twice.
const inflight = new Map();

function locateBoth(game, kinds) {
  const options = { steamRoots: scan.steamRoots(), appRoot: APP_ROOT, cacheDir: COVERS_DIR };
  return {
    cover: kinds.includes('cover') ? covers.locate(game, options) : null,
    hero: kinds.includes('hero') ? covers.locateHero(game, options) : null,
  };
}

ipcMain.handle('covers:get', async (_event, { game, kinds = ['cover'] } = {}) => {
  try {
    if (!game || !game.id) return { ok: false, error: 'No game given.' };
    const wanted = kinds.filter(kind => kind === 'cover' || kind === 'hero');
    let found = locateBoth(game, wanted);
    const missing = wanted.filter(kind => !found[kind]);
    if (missing.length && profiles.readSettings(DATA_ROOT).fetchArtwork) {
      const key = `${game.id}|${missing.join(',')}`;
      if (!inflight.has(key)) {
        inflight.set(key, art.fetchArt(game, { kinds: missing }).finally(() => inflight.delete(key)));
      }
      await inflight.get(key);
      found = locateBoth(game, wanted);
    }
    const out = { ok: true, cover: null, hero: null };
    for (const kind of wanted) {
      if (!found[kind]) continue;
      const dataUrl = covers.readAsDataUrl(found[kind].file);
      if (dataUrl) out[kind] = { dataUrl, shape: found[kind].shape, source: found[kind].source };
    }
    return out;
  } catch (error) { return fail(error); }
});

// ---------------------------------------------------------------- app + window

ipcMain.handle('settings:get', async () => ({ ok: true, settings: profiles.readSettings(DATA_ROOT) }));

ipcMain.handle('settings:set', async (_event, patch) => {
  try {
    const settings = profiles.writeSettings(DATA_ROOT, patch || {});
    if (window_ && patch && patch.theme) window_.setBackgroundColor(THEME_BACKGROUND[settings.theme]);
    return { ok: true, settings };
  } catch (error) { return fail(error); }
});

ipcMain.handle('activity:list', async () => ({ ok: true, entries: log.list() }));

ipcMain.handle('activity:clear', async () => { log.clear(); return { ok: true }; });

ipcMain.handle('clipboard:write', async (_event, { text }) => {
  try { clipboard.writeText(String(text || '')); return { ok: true }; } catch (error) { return fail(error); }
});

ipcMain.handle('window:control', async (_event, { action }) => {
  if (!window_) return { ok: false, error: 'no window' };
  if (action === 'minimize') window_.minimize();
  else if (action === 'maximize') { if (window_.isMaximized()) window_.unmaximize(); else window_.maximize(); }
  else if (action === 'close') window_.close();
  return { ok: true, maximized: window_.isDestroyed() ? false : window_.isMaximized() };
});

ipcMain.handle('shell:openFolder', async (_event, { dir }) => {
  try {
    if (dir === 'covers') fs.mkdirSync(COVERS_DIR, { recursive: true });
    const named = { app: APP_ROOT, covers: COVERS_DIR, runtimes: path.join(APP_ROOT, 'runtimes'), payload: path.join(APP_ROOT, 'payload') };
    const target = named[dir] || dir;
    const outcome = await shell.openPath(target);
    return outcome ? { ok: false, error: outcome } : { ok: true };
  } catch (error) { return fail(error); }
});

// Only these links, by name. The page never hands this process a URL.
const LINKS = {
  official: 'https://github.com/revingale32/dlss5-aio-installer',
  releases: 'https://github.com/revingale32/dlss5-aio-installer/releases',
  upstream: 'https://github.com/kibblerz/DLSS5-Reshade-AIO',
  reshade: 'https://reshade.me',
  reshadeSource: 'https://github.com/crosire/reshade',
  apache: 'https://www.apache.org/licenses/LICENSE-2.0',
};

ipcMain.handle('shell:openLink', async (_event, { name }) => {
  const url = LINKS[name];
  if (!url) return { ok: false, error: `No such link: ${name}` };
  try { await shell.openExternal(url); return { ok: true }; } catch (error) { return fail(error); }
});

ipcMain.handle('app:info', async () => ({
  ok: true,
  version: app.getVersion(),
  build: BUILD,
  appRoot: APP_ROOT,
  coversDir: COVERS_DIR,
  logFile: logreport.defaultLogFile(),
  settings: profiles.readSettings(DATA_ROOT),
  maximized: window_ ? window_.isMaximized() : false,
  platform: process.platform,
}));
