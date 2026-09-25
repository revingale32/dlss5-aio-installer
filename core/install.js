// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');
const journal = require('./journal');
const ini = require('./ini');
const anticheat = require('./anticheat');
const runtimes = require('./runtimes');
const pe = require('./pe');
const machine = require('./machine');

const SECTION = 'Standalone.DLSSNR';
const ADDON = 'standalone-dlssnr.addon64';
// Where ReShade looks for the companion shaders, recursive. Applied through
// ini.repairSearchPaths so a user's other paths survive and the doubled
// wildcard ReShade Setup 6.8 writes is collapsed (see ini.js).
const SEARCH_PATHS = { EffectSearchPaths: '.\\reshade-shaders\\Shaders\\**', TextureSearchPaths: '.\\reshade-shaders\\Textures\\**' };
const MANIFEST = 'manifest.json';
const BUILD = '2.2.4-revin4';

// ---------------------------------------------------------------- guards

// ReShade rewrites the whole ReShade.ini from memory when the game exits, so
// anything we change underneath a running game is silently thrown away. There
// is no reliable way to ask "is this game running" without a process list, so
// the check is a positive one: the add-on's own log is touched every five
// seconds while it runs.
function isGameLikelyRunning({ logFile = defaultLogFile(), withinMs = 20000 } = {}) {
  try {
    const age = Date.now() - fs.statSync(logFile).mtimeMs;
    return age < withinMs;
  } catch {
    return false;      // no log at all: nothing of ours is running
  }
}

function defaultLogFile() {
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, 'RHI', 'Logs', 'standalone-dlssnr.log') : '';
}

// The GPU probe shells out to nvidia-smi, so it runs once and is reused for a
// minute; a plan is re-made on every dropdown change.
let machineCache = { at: 0, key: '', value: null };
function inspectMachine(runtimeFiles, { probe = null, ttlMs = 60000 } = {}) {
  if (probe) return probe({ runtimeFiles });          // a caller-supplied probe is never cached
  const key = JSON.stringify(runtimeFiles);
  if (machineCache.value && machineCache.key === key && Date.now() - machineCache.at < ttlMs) return machineCache.value;
  const value = machine.inspect({ runtimeFiles });
  machineCache = { at: Date.now(), key, value };
  return value;
}

// A game folder that already holds an nvngx.dll that is not our caller bridge:
// the add-on searches the game folder before the machine-wide set and would
// load that file as its bridge, which crashes DLSS SR creation (upstream
// issue #6, a 10 KB nvngx.dll from another tool). It is moved aside, with a
// backup, and restore puts it back.
function foreignBridge(gameDir, bridgeFile) {
  const candidate = path.join(gameDir, 'nvngx.dll');
  let stat;
  try { stat = fs.statSync(candidate); } catch { return null; }
  if (!stat.isFile()) return null;
  try {
    if (fs.existsSync(bridgeFile) && journal.sha256(candidate) === journal.sha256(bridgeFile)) return null;
  } catch { /* unreadable: treat as foreign */ }
  return { file: candidate, bytes: stat.size };
}

// Games that ship their own DLSS stack in the game folder (NVIDIA Streamline plus the
// nvngx_* runtimes it drives). On its own this is NOT a problem for our standalone: GTA V
// Enhanced and Black Ops III both have it and run the kit fine, as long as the game's own
// frame generation stays off. It becomes a routing decision only when native ray
// reconstruction is among them - see nativeRayReconstruction() below.
const ENGINE_NEURAL = [
  ['nvngx_dlss.dll', 'DLSS super resolution'],
  ['nvngx_dlssd.dll', 'DLSS ray reconstruction'],
  ['nvngx_dlssg.dll', 'DLSS frame generation'],
  ['sl.interposer.dll', 'NVIDIA Streamline'],
  ['sl.common.dll', 'NVIDIA Streamline'],
  ['sl.dlss.dll', 'NVIDIA Streamline'],
];

// Runtimes the GAME shipped in its own folder. Our own installs never put these there (they go
// machine-wide), so anything found here came with the game.
function engineOwnedNeural(gameDir) {
  const found = [];
  for (const [file, label] of ENGINE_NEURAL) {
    try {
      const stat = fs.statSync(path.join(gameDir, file));
      if (stat.isFile()) found.push({ file, label, bytes: stat.size });
    } catch { /* not present */ }
  }
  return found;
}

// The one signal that actually separates a game our standalone cannot live in from one
// it can. GTA V Enhanced and Black Ops III both ship Streamline + nvngx_dlss/dlssg in
// their folders and run our kit fine; PRAGMATA additionally ships NVIDIA's ray
// reconstruction (nvngx_dlssd.dll / sl.dlss_d.dll) - a neural denoiser wired deep into
// the engine's own pipeline - and froze at 1 fps beside our private NGX instance.
// Games like that take the OptiScaler route, which cooperates with the native pipeline.
function nativeRayReconstruction(gameDir) {
  return ['nvngx_dlssd.dll', 'sl.dlss_d.dll'].filter(f => {
    try { return fs.statSync(path.join(gameDir, f)).isFile(); } catch { return false; }
  });
}

// Every file of a directory tree, relative to it. Used to lay the OptiScaler backend
// folder into a game exactly as its release archive has it.
function walkFiles(root) {
  const out = [];
  const visit = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full); else if (e.isFile()) out.push(path.relative(root, full));
    }
  };
  visit(root);
  return out;
}

function manifestFile(gameDir) {
  return path.join(journal.stateDir(gameDir), MANIFEST);
}

function readManifest(gameDir) {
  try { return JSON.parse(fs.readFileSync(manifestFile(gameDir), 'utf8')); } catch { return null; }
}

function isInstalled(gameDir) {
  const manifest = readManifest(gameDir);
  return Boolean(manifest && manifest.installed);
}

// ---------------------------------------------------------------- what is on disk

// The add-on's name string carries its version; reading it off the file is
// how a kit installed by hand (or by an older build of this app) gets a
// build number in the library instead of "not installed".
function readAddonBuild(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(fd).size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    const match = buffer.toString('latin1').match(/Standalone DLSS-NR \+ SR ([0-9A-Za-z.\-]+)/);
    return match ? match[1] : null;
  } catch { return null; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// The OptiScaler route: wilsjo2/OptiScaler-DLSSNR-PreSR-Multipass, an OptiScaler fork
// that puts neural rendering INSIDE a game's own DLSS pipeline (before its Super
// Resolution / Ray Reconstruction) instead of running a private one beside it. GPL-3.0;
// ships no NVIDIA files. It is what the community runs PRAGMATA on.
const OPTISCALER_VERSION = 'v0.8.8';
const OPTISCALER_DIR = 'OptiScaler';           // its backend folder, beside the proxy
const OPTISCALER_INI = 'OptiScaler.ini';
const OPTISCALER_PROXIES = ['dxgi.dll', 'winmm.dll', 'dbghelp.dll', 'version.dll', 'dinput8.dll'];

// The proxy name our own earlier OptiScaler install used here, if that file is still
// exactly what we wrote - an update must replace it in place.
function installedOptiScalerProxy(gameDir) {
  const manifest = readManifest(gameDir);
  if (!manifest || !manifest.installed || manifest.route !== 'optiscaler') return null;
  const root = path.resolve(gameDir).toLowerCase();
  for (const entry of manifest.records || []) {
    if (!entry || !entry.target || !entry.installedSha) continue;
    const name = path.basename(String(entry.target)).toLowerCase();
    if (!OPTISCALER_PROXIES.includes(name) || path.dirname(path.resolve(entry.target)).toLowerCase() !== root) continue;
    try { if (journal.sha256(entry.target) === entry.installedSha) return name; } catch { /* gone */ }
  }
  return null;
}

// An OptiScaler build carries OriginalFilename "OptiScaler.dll" in its version resource,
// whatever it was renamed to. The resource section sits at the end of the file.
function isOptiScalerBuild(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const marker = Buffer.from('OriginalFilename', 'utf16le');
    const name = Buffer.from('OptiScaler.dll', 'utf16le');
    for (let at = buffer.indexOf(marker); at >= 0; at = buffer.indexOf(marker, at + 2)) {
      if (buffer.indexOf(name, at) - at <= marker.length + 8 && buffer.indexOf(name, at) > at) return true;
    }
    return false;
  } catch { return false; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function existingOptiScalerProxy(gameDir) {
  for (const name of OPTISCALER_PROXIES) {
    const file = path.join(gameDir, name);
    if (fs.existsSync(file) && isOptiScalerBuild(file)) return name;
  }
  return null;
}

const LAUNCHER = 'neural-relay-launcher.addon32';
const LAUNCHER_INI = 'neural-relay-launcher.ini';
const RELAY_DIR = 'neural-relay';

// Evidence of an install this app did not make: the add-on beside the game,
// or the relay launcher for a 32-bit game. Reported as "found", never as
// managed - there are no backups to restore from.
function detect(gameDir) {
  const addon = path.join(gameDir, ADDON);
  if (fs.existsSync(addon)) {
    return { present: true, route: 'game', build: readAddonBuild(addon), hasProfile: hasProfile(gameDir) };
  }
  // OptiScaler: its ini plus its backend folder beside the game. The proxy it loads as
  // can be any of several names, so the folder is the reliable marker.
  if (fs.existsSync(path.join(gameDir, OPTISCALER_INI)) && fs.existsSync(path.join(gameDir, OPTISCALER_DIR, 'dlssnr'))) {
    let build = 'OptiScaler NR';
    try {
      const text = fs.readFileSync(path.join(gameDir, OPTISCALER_INI), 'utf8');
      const nr = (ini.readSectionFrom(text, 'DlssNr') || {}).Enabled;
      build = `OptiScaler NR${/true/i.test(String(nr)) ? '' : ' (NR off)'}`;
    } catch { /* keep the generic label */ }
    return { present: true, route: 'optiscaler', build, hasProfile: false };
  }
  const launcher = path.join(gameDir, LAUNCHER);
  if (fs.existsSync(launcher)) {
    let relayDir = path.join(gameDir, RELAY_DIR);
    try {
      const text = fs.readFileSync(path.join(gameDir, LAUNCHER_INI), 'utf8');
      const configured = (ini.readSectionFrom(text, 'NeuralRelay') || {}).Path;
      if (configured && fs.existsSync(configured)) relayDir = path.dirname(configured);
    } catch { /* default relay location */ }
    return {
      present: true, route: 'relay', relayDir,
      build: readAddonBuild(path.join(relayDir, ADDON)),
      hasProfile: hasProfile(relayDir),
    };
  }
  return { present: false };
}

function hasProfile(dir) {
  try { return /^\[Standalone\.DLSSNR\]/m.test(fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8')); } catch { return false; }
}

// One answer for the library and the sheet: managed by this app, found on
// disk, or neither.
function status(gameDir) {
  const manifest = readManifest(gameDir);
  if (manifest && manifest.installed) {
    const check = verify(gameDir);
    return { installed: true, managed: true, route: manifest.route || 'game', build: manifest.build, installedAt: manifest.installedAt, backupDir: manifest.backupDir,
      intact: !check.gameUpdated, changedSinceInstall: check.gameUpdated ? [...check.changed, ...check.missing] : [], verifySummary: check.summary || null };
  }
  const found = detect(gameDir);
  if (found.present) return { installed: true, managed: false, route: found.route, build: found.build, installedAt: null, backupDir: null };
  return { installed: false, managed: false, route: null, build: null, installedAt: null, backupDir: null };
}

// ---------------------------------------------------------------- planning

function machineWideDir() {
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, 'RHI', 'Custom', 'Addons') : null;
}

// Which route a game takes. The add-on is 64-bit: it loads inside a 64-bit
// game. A 32-bit game cannot load it, so the relay runs beside the game
// instead - a 64-bit process that captures the game's window, runs the same
// add-on on those frames and overlays the result; a tiny 32-bit launcher
// add-on in the game folder starts it and caps the game's frame rate so it
// does not starve the neural work.
function routeFor(exe, gameDir = null, { route = null } = {}) {
  if (!exe) return 'game';
  if (exe.bitness === 32) return 'relay';                 // nothing 64-bit loads in there
  if (route === 'game' || route === 'optiscaler') return route;   // the person chose
  // Ray reconstruction only exists on D3D12/Vulkan, so a game shipping it is a modern-API
  // game whatever the import table says - RE Engine executables import d3d11.dll too and
  // read as "D3D11" (PRAGMATA did), which must not send them to our kit. Only a genuine
  // D3D9/OpenGL reading, which OptiScaler cannot host, keeps the standalone route.
  if (gameDir && exe.api !== 'd3d9' && exe.api !== 'opengl' && nativeRayReconstruction(gameDir).length) return 'optiscaler';
  return 'game';
}

function hookFor(exe, hookName) {
  if (hookName) return hookName;
  if (exe && exe.api === 'd3d9') return 'd3d9.dll';
  if (exe && exe.api === 'opengl') return 'opengl32.dll';
  return 'dxgi.dll';
}

// Work out what would happen, without touching anything. The UI shows this
// before the button does anything, and the CLI prints it for --dry-run.
function plan(target, options = {}) {
  const {
    appRoot = path.join(__dirname, '..'),
    hookName = null,
    profile = {},
    extraRuntimeDirs = [],
    probe,
    allowUnknownNeural = false,
  } = options;
  // The environment switch exists for the test suites, whose fake runtimes have no known hash.
  const allowUnknown = allowUnknownNeural === true || process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME === '1';

  const gameDir = target.dir;
  const problems = [];
  const notes = [];

  const exe = target.exe || null;
  if (!exe) problems.push('No executable was chosen for this folder.');
  if (exe && !exe.renders) {
    notes.push(`No graphics runtime could be found in ${exe.name}, by import or by name. It may be a `
      + 'launcher rather than the game - check the executable above before installing.');
  }
  const route = routeFor(exe, gameDir, { route: options.route || null });

  const payloadDir = path.join(appRoot, 'payload');
  const reshade64 = path.join(payloadDir, 'ReShade64.dll');
  const reshade32 = path.join(payloadDir, 'ReShade32.dll');
  const addon = path.join(payloadDir, ADDON);
  const bridge = path.join(payloadDir, 'nvngx.dll');
  const relayExe = path.join(payloadDir, 'relay', 'neural-relay.exe');
  const launcher = path.join(payloadDir, 'relay', LAUNCHER);
  const shaders = ['DLSS5_AIO_Feed.fx', 'StandaloneBoundary.fx'].map(name => path.join(payloadDir, 'shaders', name));
  const optiDir = path.join(payloadDir, 'optiscaler');
  const optiDll = path.join(optiDir, 'OptiScaler.dll');
  if (route === 'optiscaler') {
    if (!fs.existsSync(optiDll) || !fs.existsSync(path.join(optiDir, OPTISCALER_INI)) || !fs.existsSync(path.join(optiDir, OPTISCALER_DIR)))
      problems.push('Payload is incomplete: the OptiScaler neural-rendering build is missing (needed for a game with native ray reconstruction).');
  } else {
    if (!fs.existsSync(addon)) problems.push(`Payload is incomplete: ${ADDON} is missing.`);
    if (!fs.existsSync(reshade64)) problems.push('Payload is incomplete: ReShade64.dll is missing.');
  }
  if (route === 'relay') {
    if (!fs.existsSync(reshade32)) problems.push('Payload is incomplete: ReShade32.dll is missing (needed for a 32-bit game).');
    if (!fs.existsSync(relayExe) || !fs.existsSync(launcher)) problems.push('Payload is incomplete: the neural relay is missing (needed for a 32-bit game).');
  }

  const found = runtimes.locate({ appRoot, extraDirs: extraRuntimeDirs, games: options.runtimeGames || [] });
  const runtimeState = runtimes.describe(found);
  let runtimeCheck = null;
  if (!runtimeState.ok) problems.push(runtimeState.message);
  else {
    if (/not found/.test(runtimeState.message)) notes.push(runtimeState.message);
    // The files exist and are the right size; now: are they the files this
    // build was validated with? A wrong neural runtime is refused here rather
    // than discovered as "NR never starts" after the install.
    runtimeCheck = runtimes.verify(found, { allowUnknownNeural: allowUnknown });
    if (!runtimeCheck.ok) problems.push(runtimeCheck.message);
    notes.push(...runtimeCheck.notes);
  }

  // A folder we cannot write to fails at the first file, after the backups
  // have started. Say so first. Xbox app games are the usual case: their
  // folders are locked until "mod support" is enabled in the Xbox app, and
  // some need the installer run as administrator on top.
  if (fs.existsSync(gameDir)) {
    try { fs.accessSync(gameDir, fs.constants.W_OK); }
    catch {
      problems.push(target.store === 'Xbox' || /WindowsApps|XboxGames/i.test(gameDir)
        ? 'This Xbox app game folder is not writable. In the Xbox app open the game\'s page → ... → '
          + 'Manage → Files → Enable mod support (Windows may ask you to sign in), then rescan. If it is '
          + 'still locked, run this installer as administrator.'
        : 'This folder is not writable. Check its permissions or run this installer as administrator.');
    }
  }

  const cheat = anticheat.detect(gameDir);

  // Can this PC run these runtimes at all? Read off the files and the card.
  const readiness = inspectMachine({
    nr: found.nr ? found.nr.file : null, sr: found.sr ? found.sr.file : null, fg: found.fg ? found.fg.file : null,
  }, probe ? { probe } : {});
  // The stock runtime exports "minimum architecture: Blackwell" and the readiness check
  // believes it. The cross-generation build keeps that export but branches on the card
  // inside, so for that exact file the architecture block is a false alarm.
  const crossGen = Boolean(runtimeCheck && runtimeCheck.details.nr && runtimeCheck.details.nr.modified);
  problems.push(...readiness.problems.filter(p => !(crossGen && /nvngx_dlssnr/.test(p))));
  notes.push(...readiness.notes);
  if (crossGen && readiness.problems.some(p => /nvngx_dlssnr/.test(p))) {
    notes.push('The neural runtime here is the cross-generation build, so the "needs Blackwell" check is waived: it selects an '
      + 'RTX 20/30 or RTX 40 path on those cards itself. Expect it to be much slower than on an RTX 50.');
  }

  const machineWide = machineWideDir();
  if (!machineWide) problems.push('LOCALAPPDATA is not set; the machine-wide runtime folder cannot be found.');

  // The hook name is which DLL ReShade is loaded as. dxgi covers DX10/11/12 and
  // is right nearly always; a DX11 game that never touches DXGI directly needs
  // d3d11 instead.
  const hook = hookFor(exe, hookName);
  const files = [];
  const iniEdits = [];
  const fullProfile = { ...defaultProfile(), ...profile };

  // The runtime set the add-on loads has to be complete in ONE folder: NR, SR
  // and the caller bridge together (FG optional). It searches the game folder
  // first, then this machine-wide folder, and a folder missing any one of the
  // three is skipped. So everything goes to the machine-wide folder, once,
  // shared by every game - and a game's restore leaves it alone.
  if (machineWide) {
    if (fs.existsSync(bridge)) {
      files.push({ from: bridge, to: path.join(machineWide, 'nvngx.dll'), role: 'NGX caller-identity bridge (machine-wide)', outsideGame: true, shared: true, skipIfSame: true });
    }
    for (const kind of ['nr', 'sr', 'fg']) {
      if (!found[kind]) continue;
      const to = path.join(machineWide, runtimes.WANTED[kind]);
      if (path.dirname(found[kind].file).toLowerCase() === machineWide.toLowerCase()) continue;   // already there
      files.push({
        from: found[kind].file, to,
        role: `NVIDIA ${kind === 'nr' ? 'neural rendering' : kind === 'sr' ? 'super resolution' : 'frame generation'} runtime (copied from your PC, machine-wide)`,
        outsideGame: true, shared: true, skipIfSame: true,
      });
    }
  }

  if (route === 'game') {
    files.push({ from: reshade64, to: path.join(gameDir, hook), role: 'ReShade (add-on build)' });
    files.push({ from: addon, to: path.join(gameDir, ADDON), role: 'DLSS 5 neural rendering add-on' });
    for (const shader of shaders) {
      if (fs.existsSync(shader)) files.push({ from: shader, to: path.join(gameDir, 'reshade-shaders', 'Shaders', path.basename(shader)), role: 'companion shader', skipIfSame: true });
    }
    iniEdits.push({
      file: path.join(gameDir, 'ReShade.ini'),
      sections: { [SECTION]: fullProfile, ADDON: { AddonPath: '.\\' } },
      searchPaths: SEARCH_PATHS,
      // Home opens the ReShade overlay in game, which is where these settings are
      // meant to be changed - the panel in this app only sets where they start.
      // Only filled in when absent, so a rebind survives a reinstall.
      defaults: { INPUT: { KeyOverlay: '36,0,0,0' } },
      enableAddon: 'standalone-dlssnr',
      role: 'ReShade settings + the [Standalone.DLSSNR] profile',
    });
    let existingIni = '';
    try { existingIni = fs.readFileSync(path.join(gameDir, 'ReShade.ini'), 'utf8'); } catch { /* none yet */ }
    if (ini.hasBrokenSearchPaths(existingIni)) {
      notes.push('ReShade.ini here has a shader search path ending in "\\**\\**" (ReShade Setup 6.8 writes it that way). '
        + 'Windows rejects that path, so no shader in the folder ever loaded. Installing repairs it and keeps any other paths you added.');
    }
  } else if (route === 'optiscaler') {
    // OptiScaler loads as a proxy DLL the game already imports. dxgi.dll is its usual
    // first choice; if some other loader already owns dxgi.dll here, take winmm.dll so
    // the two chain instead of colliding. Our own ReShade in dxgi.dll is not "some other
    // loader" - it is what this route replaces, and the journal backs it up. Neither is an
    // OptiScaler already here - ours from an earlier install, or one the person put in by
    // hand: an update replaces it under the same name. Chaining a second OptiScaler beside
    // the first (the old behaviour on an update: new build as winmm.dll, old one still
    // loading as dxgi.dll) runs two copies of it in one game.
    const managedProxy = installedOptiScalerProxy(gameDir);
    const presentProxy = managedProxy || existingOptiScalerProxy(gameDir);
    let proxy = presentProxy || 'dxgi.dll';
    const existingProxy = path.join(gameDir, 'dxgi.dll');
    if (!presentProxy && fs.existsSync(existingProxy) && !sameFile(existingProxy, reshade64) && !sameFile(existingProxy, optiDll)) proxy = 'winmm.dll';
    if (presentProxy && !managedProxy) {
      notes.push(`An OptiScaler build is already loading here as ${presentProxy}. Two OptiScalers in one game conflict, so this `
        + `one replaces it under the same name; the original is backed up and "Restore originals" puts it back.`);
    }
    files.push({ from: optiDll, to: path.join(gameDir, proxy), role: `OptiScaler neural rendering (${OPTISCALER_VERSION}), loaded as ${proxy}` });
    for (const rel of walkFiles(path.join(optiDir, OPTISCALER_DIR))) {
      files.push({ from: path.join(optiDir, OPTISCALER_DIR, rel), to: path.join(gameDir, OPTISCALER_DIR, rel), role: 'OptiScaler backend', skipIfSame: true });
    }
    // OptiScaler needs the neural runtime beside the proxy or the executable. This is the
    // user's own file, copied from wherever this PC has it - never shipped.
    if (found.nr) {
      files.push({ from: found.nr.file, to: path.join(gameDir, runtimes.WANTED.nr), role: 'NVIDIA neural rendering runtime (your own copy, beside OptiScaler as it requires)', skipIfSame: true });
    }
    // Two neural-rendering injectors in one game conflict (the fork's own guide says so).
    // Anything of our standalone kit already here is moved aside; Restore puts it back.
    for (const name of [ADDON, 'ReShade.ini']) {
      const f = path.join(gameDir, name);
      if (!fs.existsSync(f)) continue;
      if (name === 'ReShade.ini' && !hasProfile(gameDir)) continue;   // someone's unrelated ReShade config: leave it
      files.push({ action: 'park', from: f, to: `${f}.dlss5-parked`, role: `the standalone kit's ${name} - moved aside; the two injectors cannot coexist` });
    }
    iniEdits.push({
      file: path.join(gameDir, OPTISCALER_INI),
      template: path.join(optiDir, OPTISCALER_INI),
      sections: {
        DlssNr: { Enabled: 'true', RunBeforeSR: 'true', Passes: String(fullProfile.Passes || '1'), WorkingScale: '1.0' },
        ProcessFilter: { TargetProcessName: 'auto' },
        Log: { LogToFile: 'true', LogLevel: '2' },
      },
      role: 'OptiScaler settings: neural rendering on, before the game\'s own upscaler, one pass',
    });
    notes.push(`${exe ? exe.name : 'This game'} ships NVIDIA ray reconstruction (${nativeRayReconstruction(gameDir).join(', ')}) and drives `
      + 'its whole DLSS pipeline itself. Our standalone add-on runs a second neural pipeline beside that and the two fight - '
      + 'PRAGMATA froze at 1 fps this way. So this game takes the OptiScaler route instead: an open-source fork that puts '
      + 'neural rendering inside the game\'s own DLSS pass, before its upscaling and ray reconstruction. Turn DLSS on in the '
      + 'game\'s own settings, then press Insert in game for OptiScaler\'s menu. It uses your own neural runtime, copied beside it.');
  } else {
    const relayDir = path.join(gameDir, RELAY_DIR);
    files.push({ from: reshade32, to: path.join(gameDir, hook), role: 'ReShade 32-bit (add-on build) - loads the launcher only' });
    files.push({ from: launcher, to: path.join(gameDir, LAUNCHER), role: 'relay launcher add-on (starts the relay, caps the game\'s fps)' });
    files.push({ from: relayExe, to: path.join(relayDir, 'neural-relay.exe'), role: 'neural relay (64-bit; captures the game window, overlays the result)' });
    files.push({ from: reshade64, to: path.join(relayDir, 'dxgi.dll'), role: 'ReShade (add-on build) for the relay' });
    files.push({ from: addon, to: path.join(relayDir, ADDON), role: 'DLSS 5 neural rendering add-on, run by the relay' });
    for (const shader of shaders) {
      if (fs.existsSync(shader)) files.push({ from: shader, to: path.join(relayDir, 'reshade-shaders', 'Shaders', path.basename(shader)), role: 'companion shader', skipIfSame: true });
    }
    iniEdits.push({
      file: path.join(gameDir, LAUNCHER_INI),
      sections: { NeuralRelay: { Args: '--borderless --alt-enter', FpsCap: 'auto' } },
      role: 'launcher settings (relay in the neural-relay folder beside the game)',
    });
    iniEdits.push({
      file: path.join(gameDir, 'ReShade.ini'),
      sections: { ADDON: { AddonPath: '.\\' } },
      defaults: { INPUT: { KeyOverlay: '36,0,0,0' } },
      enableAddon: 'neural-relay-launcher',
      role: 'the game\'s ReShade settings (32-bit)',
    });
    iniEdits.push({
      file: path.join(relayDir, 'ReShade.ini'),
      sections: {
        [SECTION]: { ...fullProfile, OpaqueComposition: '1' },
        ADDON: { AddonPath: '.\\' },
      },
      searchPaths: SEARCH_PATHS,
      defaults: { INPUT: { KeyOverlay: '36,0,0,0' } },
      enableAddon: 'standalone-dlssnr',
      role: 'the relay\'s ReShade settings + the [Standalone.DLSSNR] profile',
    });
    notes.push(`${exe ? exe.name : 'This game'} is 32-bit, so nothing neural runs inside it. A small launcher add-on starts the `
      + 'neural relay beside the game; the relay captures the game window, runs the same add-on on those frames and shows the '
      + 'result in a click-through overlay. Set the game to windowed or borderless (the relay cannot capture exclusive '
      + 'fullscreen). The launcher caps the game at your refresh rate, 90 max, so it does not starve the neural work. '
      + 'Ctrl+Alt+M hands input to the relay so Home opens its menu; Ctrl+Alt+M again gives it back.');
  }

  const foreign = foreignBridge(gameDir, bridge);
  if (foreign) {
    files.push({
      action: 'park',
      from: foreign.file,
      to: `${foreign.file}.dlss5-parked`,
      role: 'a different nvngx.dll (not our caller bridge) - moved aside so the add-on does not load it',
    });
    notes.push(`The game folder already has an nvngx.dll (${(foreign.bytes / 1024).toFixed(0)} KB) that is not this `
      + 'kit\'s caller bridge - it belongs to another DLSS tool. The add-on looks in the game folder first and would '
      + 'load it, which crashes DLSS SR creation. It will be renamed to nvngx.dll.dlss5-parked; "Restore originals" puts it back.');
  }

  const engineNeural = engineOwnedNeural(gameDir);
  if (engineNeural.length && route === 'game') {
    // Native DLSS alone is fine beside our kit (GTA V Enhanced, Black Ops III). The one
    // thing that is not fine is the game's OWN frame generation running at the same time.
    notes.push(`This game has DLSS built in (${engineNeural.map(r => r.file).join(', ')}). That is fine beside this kit - `
      + 'but leave the game\'s own frame generation OFF in its settings; two frame generators in one game break the '
      + 'add-on\'s presentation. Use the kit\'s frame generation (Ctrl+Alt+G) if you want it.');
  }

  const current = status(gameDir);
  if (current.installed && !current.managed) {
    notes.push(`The kit is already here (build ${current.build || 'unknown'}, ${current.route === 'relay' ? 'relay route' : 'in the game folder'}) but was not `
      + 'installed by this app, so there are no backups yet. Installing from here replaces it with this build and backs up what is there now.');
  }

  return {
    gameDir,
    exe,
    route,
    hook,
    files,
    iniEdits,
    profile: fullProfile,
    anticheat: cheat,
    runtimes: found,
    problems,
    notes,
    installable: problems.length === 0,
    alreadyInstalled: current.installed,
    current,
    machine: readiness,
    runtimeCheck,
  };
}

// What a game starts with the first time it is installed. These are deliberately the
// LIGHTEST, most conservative settings the kit supports, not the prettiest or the
// fastest-looking: one neural pass, the cheapest model, and frame generation off.
// Every one of them is a live toggle in the ReShade overlay (Home), so the person who
// installed it decides what they actually want on their own machine and their own card -
// this is a starting point, not a recommendation. Frame generation in particular is off
// because it routes presentation through a composited overlay that costs real latency,
// which is the wrong default for a game the user may not want it in.
function defaultProfile() {
  return {
    Enabled: '1',
    NeuralRendering: '1',
    Passes: '1',
    Model: '1',
    Intensity: '1.4000',
    LocalTone: '1.2000',
    LocalStructure: '1.2000',
    SkinStructure: '0.1700',
    DlssRenderPreset: '12',
    AsyncComputePipeline: '1',
    PipelineRateLock: '1',
    AdaptivePressureGovernor: '0',
    NeuralQueuePriorityHigh: '1',
    PresentQueueLimit: '1',
    SynchronousProxyPresentation: '0',
    SerializedPresenterMigrated: '1',
    FrameGeneration: '0',
    FrameGenMultiplier: '2',
    FrameGenEvenPacing: '0',
    FrameGenPacingBias: '0.25',
    NvidiaOpticalFlowMotion: '1',
    AutoStableSrNoMotion: '1',
    UiGuard: '1',
    UiGuardStrength: '0.90',
    UiGuardThreshold: '0.28',
    PrivateNgxCore: '1',
    PerformanceTelemetry: '1',
    MouseWarp: '0',
    MouseWarpPixelsPerCount: '0.00',
    NeuralResidualScale: '1.00',
  };
}

// ---------------------------------------------------------------- apply

function apply(planned, { acknowledgedAntiCheat = false, logFile, appRoot = path.join(__dirname, '..') } = {}) {
  if (!planned.installable) {
    throw new Error(`Cannot install: ${planned.problems.join(' ')}`);
  }
  if (planned.anticheat.present && acknowledgedAntiCheat !== true) {
    const error = new Error('Anti-cheat was detected and the risk has not been acknowledged.');
    error.code = 'ANTICHEAT_CONSENT_REQUIRED';
    error.warning = anticheat.warning(planned.anticheat);
    throw error;
  }
  if (isGameLikelyRunning({ logFile })) {
    const error = new Error('A game is running with the add-on right now. Close it first - ReShade '
      + 'rewrites its own ReShade.ini on exit and would discard these settings.');
    error.code = 'GAME_RUNNING';
    throw error;
  }

  // Anything left over from an install that died mid-write goes back before we
  // add to the pile.
  journal.recover(planned.gameDir);
  // A reinstall over our own files must not mistake them for the game's
  // originals: the first backup ever taken of a target is the one that
  // "restore originals" has to reach, however many installs later.
  const previous = readManifest(planned.gameDir);
  const firstOriginals = new Map();
  for (const entry of (previous && previous.records) || []) {
    if (!entry || !entry.target) continue;
    const key = String(entry.target).toLowerCase();
    if (firstOriginals.has(key)) continue;
    if (entry.existed && (!entry.backup || !fs.existsSync(entry.backup))) continue;
    firstOriginals.set(key, entry);
  }

  const txn = new journal.Transaction(planned.gameDir).begin();
  const record = { files: [], inis: [] };
  const sharedTargets = planned.files.filter(file => file.shared).map(file => file.to);
  let template = '';
  try { template = fs.readFileSync(path.join(appRoot, 'payload', 'ReShade.ini.template'), 'utf8'); } catch { /* optional */ }
  try {
    for (const file of planned.files) {
      if (file.action === 'park') {
        txn.capture(file.from);
        txn.capture(file.to);
        fs.renameSync(file.from, file.to);
        record.files.push({ to: file.to, role: file.role, outsideGame: false, parked: file.from });
        continue;
      }
      if (file.skipIfSame && sameFile(file.from, file.to)) continue;
      txn.copyFile(file.from, file.to);
      record.files.push({ to: file.to, role: file.role, outsideGame: Boolean(file.outsideGame), shared: Boolean(file.shared) });
    }

    for (const edit of planned.iniEdits || []) {
      txn.capture(edit.file);
      let text = '';
      try { text = fs.readFileSync(edit.file, 'utf8'); }
      catch {
        if (edit.template) { try { text = fs.readFileSync(edit.template, 'utf8'); } catch { text = ''; } }
        else text = path.basename(edit.file).toLowerCase() === 'reshade.ini' ? template : '';
      }
      for (const [section, values] of Object.entries(edit.sections || {})) text = ini.upsertSection(text, section, values);
      if (edit.searchPaths) text = ini.repairSearchPaths(text, edit.searchPaths);
      for (const [section, values] of Object.entries(edit.defaults || {})) text = ini.upsertSectionDefaults(text, section, values);
      if (edit.enableAddon) text = ini.enableAddon(text, edit.enableAddon);
      fs.mkdirSync(path.dirname(edit.file), { recursive: true });
      fs.writeFileSync(edit.file, text, 'utf8');
      record.inis.push(edit.file);
    }

    txn.commit();
  } catch (error) {
    const failures = txn.rollback();
    txn.finish();
    error.rollbackFailures = failures;
    throw error;
  }
  txn.finish();

  // Settings files (ReShade.ini, OptiScaler.ini, the relay's inis) are ours to
  // seed but the game's to rewrite: ReShade saves its config whenever a setting
  // changes, OptiScaler saves from its own menu. Their hash moving is normal
  // use, not a game update - verify and restore treat them accordingly.
  const configTargets = new Set(record.inis.map(file => String(file).toLowerCase()));

  const manifest = {
    installed: true,
    installedAt: new Date().toISOString(),
    build: BUILD,
    route: planned.route || 'game',
    gameDir: planned.gameDir,
    exe: planned.exe ? planned.exe.file : null,
    hook: planned.hook,
    transaction: txn.id,
    backupDir: txn.dir,
    records: txn.records.map(r => {
      const first = firstOriginals.get(String(r.target).toLowerCase());
      const installedSha = (() => { try { return journal.sha256(r.target); } catch { return null; } })();
      const config = configTargets.has(String(r.target).toLowerCase());
      const entry = first
        ? { target: r.target, backup: first.backup, existed: first.existed, installedSha, firstOriginalFrom: first.firstOriginalFrom || (previous && previous.transaction) || null }
        : { target: r.target, backup: r.backup, existed: r.existed, installedSha };
      return config ? { ...entry, config: true } : entry;
    }),
    sharedTargets,
    files: record.files,
    reshadeIni: record.inis[0] || null,
    inis: record.inis,
    antiCheat: planned.anticheat.systems,
  };
  // A reinstall over a live install whose payload dropped a file (an OptiScaler update that
  // no longer ships some backend file) would otherwise lose track of it: the new transaction
  // never touches it, so restore would leave it behind. Carry the previous record forward.
  if (previous && previous.installed) {
    const current = new Set(manifest.records.map(r => String(r.target).toLowerCase()));
    for (const entry of previous.records || []) {
      if (!entry || !entry.target || current.has(String(entry.target).toLowerCase())) continue;
      if (!entry.existed && !fs.existsSync(entry.target)) continue;   // already gone, nothing to undo
      manifest.records.push({ ...entry, carriedFrom: entry.carriedFrom || previous.transaction || null });
      current.add(String(entry.target).toLowerCase());
    }
  }
  fs.mkdirSync(journal.stateDir(planned.gameDir), { recursive: true });
  fs.writeFileSync(manifestFile(planned.gameDir), JSON.stringify(manifest, null, 2));
  appendHistory(planned.gameDir, { action: 'install', at: manifest.installedAt, build: manifest.build, route: manifest.route });
  return manifest;
}

function sameFile(a, b) {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.size === right.size && journal.sha256(a) === journal.sha256(b);
  } catch { return false; }
}

// ---------------------------------------------------------------- verify

// Is what we installed still what is on disk? A game update, a Steam file
// verification or another tool can overwrite the add-on or ReShade quietly;
// the install then looks present in the manifest and is gone in practice. The
// same check protects "restore originals": putting an old backup over a file
// the game has since updated would corrupt the game, not repair it.
function verify(gameDir) {
  const manifest = readManifest(gameDir);
  if (!manifest || !manifest.installed) return { installed: false, checked: 0, intact: [], changed: [], missing: [], unknown: [], settings: [], gameUpdated: false, summary: null };
  const shared = new Set((manifest.sharedTargets || []).map(target => String(target).toLowerCase()));
  const configs = configSet(manifest);
  const intact = []; const changed = []; const missing = []; const unknown = []; const settings = [];
  for (const entry of manifest.records || []) {
    if (!entry || !entry.target || shared.has(String(entry.target).toLowerCase())) continue;
    // A settings file rewritten by the game's own overlay is normal use.
    if (entry.config || configs.has(String(entry.target).toLowerCase())) { settings.push(entry.target); continue; }
    if (!entry.installedSha) { unknown.push(entry.target); continue; }
    if (!fs.existsSync(entry.target)) { missing.push(entry.target); continue; }
    let sha = null;
    try { sha = journal.sha256(entry.target); } catch { unknown.push(entry.target); continue; }
    (sha === entry.installedSha ? intact : changed).push(entry.target);
  }
  const total = intact.length + changed.length + missing.length;
  const summary = changed.length || missing.length
    ? `${changed.length + missing.length} of ${total} installed file(s) `
      + `${missing.length && !changed.length ? 'are missing' : 'have changed'} since the install on `
      + `${String(manifest.installedAt || '').slice(0, 10)} - a game update or another tool touched them. `
      + 'Reinstall to put the add-on back; "Restore originals" will leave the changed files alone.'
    : null;
  return { installed: true, checked: total, intact, changed, missing, unknown, settings, summary, gameUpdated: changed.length + missing.length > 0 };
}

// Manifests written before settings were flagged still list every ini they
// edited under `inis`; honour both.
function configSet(manifest) {
  return new Set([
    ...((manifest && manifest.inis) || []),
    ...((manifest && manifest.records) || []).filter(entry => entry && entry.config).map(entry => entry.target),
  ].map(file => String(file).toLowerCase()));
}

// ---------------------------------------------------------------- restore

// Put the folder back exactly as it was found: originals returned, our files
// removed. Deliberately reads the manifest rather than guessing from what is
// on disk, so a file the user added themselves is never deleted.
function restore(gameDir, { force = false } = {}) {
  const manifest = readManifest(gameDir);
  if (!manifest) return { restored: [], removed: [], failures: ['Nothing was installed by this app here.'], left: [], skipped: [] };

  const restored = [];
  const removed = [];
  const failures = [];
  const left = [];
  const skipped = [];
  const shared = new Set((manifest.sharedTargets || []).map(target => String(target).toLowerCase()));
  const configs = configSet(manifest);
  for (let index = (manifest.records || []).length - 1; index >= 0; index--) {
    const entry = manifest.records[index];
    // The machine-wide runtime set is shared by every game; a game's restore
    // leaves it alone rather than pulling it out from under the others.
    if (shared.has(String(entry.target).toLowerCase())) { left.push(entry.target); continue; }
    // A settings file we seeded is expected to have been rewritten since (ReShade
    // saves on every change): it goes back to the original, or goes, regardless.
    // Otherwise our [Standalone.DLSSNR] section would outlive the restore.
    const config = entry.config || configs.has(String(entry.target).toLowerCase());
    // A file that is no longer what we wrote belongs to whoever changed it -
    // usually a game update. Restoring a backup over it is not a restore.
    if (!force && !config && entry.installedSha && fs.existsSync(entry.target)) {
      let current = null;
      try { current = journal.sha256(entry.target); } catch { current = null; }
      if (current && current !== entry.installedSha) {
        skipped.push(entry.target);
        failures.push(`${path.basename(entry.target)} changed after the install (a game update?); left the newer file in place.`);
        continue;
      }
    }
    try {
      if (!entry.existed) {
        if (fs.existsSync(entry.target)) { fs.rmSync(entry.target, { force: true }); removed.push(entry.target); }
        continue;
      }
      if (!entry.backup || !fs.existsSync(entry.backup)) {
        failures.push(`Backup for ${entry.target} is missing; left it alone.`);
        continue;
      }
      fs.copyFileSync(entry.backup, entry.target);
      restored.push(entry.target);
    } catch (error) {
      failures.push(`${entry.target}: ${error.message}`);
    }
  }

  // Folders that exist only because we put files in them (OptiScaler\, reshade-shaders\Shaders\)
  // come out too, deepest first, and only while they are empty - a folder with anything
  // else in it is somebody's and stays.
  const root = path.resolve(gameDir).toLowerCase();
  const parents = new Set();
  for (const file of removed) {
    let dir = path.dirname(file);
    while (path.resolve(dir).toLowerCase() !== root && path.resolve(dir).toLowerCase().startsWith(root + path.sep)) {
      parents.add(path.resolve(dir));
      dir = path.dirname(dir);
    }
  }
  for (const dir of [...parents].sort((a, b) => b.length - a.length)) {
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* not empty or already gone */ }
  }

  const next = { ...manifest, installed: false, restoredAt: new Date().toISOString() };
  fs.writeFileSync(manifestFile(gameDir), JSON.stringify(next, null, 2));
  appendHistory(gameDir, { action: 'restore', at: next.restoredAt, restored: restored.length, removed: removed.length, skipped: skipped.length });
  return { restored, removed, failures, left, skipped };
}

function appendHistory(gameDir, entry) {
  try {
    const file = path.join(journal.stateDir(gameDir), 'history.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch { /* history is a convenience, never a blocker */ }
}

function history(gameDir) {
  try {
    return fs.readFileSync(path.join(journal.stateDir(gameDir), 'history.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

module.exports = {
  SECTION, ADDON, BUILD, LAUNCHER, LAUNCHER_INI, RELAY_DIR, OPTISCALER_VERSION, OPTISCALER_DIR, OPTISCALER_INI, OPTISCALER_PROXIES,
  plan, apply, restore, history,
  readManifest, isInstalled, detect, status, verify, readAddonBuild, manifestFile, defaultProfile,
  isGameLikelyRunning, defaultLogFile, foreignBridge, engineOwnedNeural, nativeRayReconstruction, inspectMachine, machineWideDir, routeFor, hookFor,
  installedOptiScalerProxy, existingOptiScalerProxy, isOptiScalerBuild,
};
