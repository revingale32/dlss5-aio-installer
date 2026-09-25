// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// Renders the real page in headless Chromium with a stand-in window.api, and
// screenshots every view in both themes. Not part of `npm test` - it needs a
// browser - but it is how the layout gets looked at before it ships.
//
//   node test/visual/shoot.js [outDir]

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..', '..');
const outDir = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });
// art.json holds real game artwork for nicer screenshots. It stays on the machine
// that made it (the publishers' pictures are not ours to publish); without it the
// shots use plain placeholder tiles.
const ART_FILE = path.join(__dirname, 'art.json');
const PLACEHOLDER = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#1d2a1a"/></svg>').toString('base64');
const art = fs.existsSync(ART_FILE) ? JSON.parse(fs.readFileSync(ART_FILE, 'utf8'))
  : Object.fromEntries(['gta', 're2', 'bo3', 'afe', 'avp', 'ctrl', 'halo', 'forza'].map(key => [key, { cover: PLACEHOLDER, hero: PLACEHOLDER }]));

const games = [
  { id: 'steam:271590', appid: '271590', store: 'Steam', name: 'Grand Theft Auto V Enhanced', dir: 'D:\\SteamLibrary\\steamapps\\common\\Grand Theft Auto V Enhanced', exe: { name: 'GTA5_Enhanced.exe', api: 'd3d12', apiSource: 'import', bitness: 64, renders: true, canonical: null }, anticheat: [], installed: true, managed: true, route: 'game', installedAt: new Date(Date.now() - 3600e3).toISOString(), installedBuild: '2.2.4-revin4', art: 'gta' },
  { id: 'steam:883710', appid: '883710', store: 'Steam', name: 'Resident Evil 2', dir: 'D:\\SteamLibrary\\steamapps\\common\\RESIDENT EVIL 2  BIOHAZARD RE2', exe: { name: 're2.exe', api: 'd3d12', apiSource: 'import', bitness: 64, renders: true, canonical: null }, anticheat: [], installed: true, managed: true, route: 'game', installedAt: new Date(Date.now() - 26 * 3600e3).toISOString(), installedBuild: '2.2.4-revin4', art: 're2' },
  { id: 'steam:311210', appid: '311210', store: 'Steam', name: 'Call of Duty: Black Ops III', dir: 'D:\\SteamLibrary\\steamapps\\common\\Call of Duty Black Ops III', exe: { name: 'BlackOps3.exe', api: 'd3d11', apiSource: 'import', bitness: 64, renders: true, canonical: null }, anticheat: [], installed: true, managed: false, route: 'game', installedAt: new Date(Date.now() - 3 * 86400e3).toISOString(), installedBuild: '2.2.4-revin4', art: 'bo3' },
  { id: 'steam:1549970', appid: '1549970', store: 'Steam', name: 'Aliens: Fireteam Elite', dir: 'D:\\SteamLibrary\\steamapps\\common\\Aliens Fireteam Elite', exe: { name: 'Endeavor-Win64-Shipping.exe', api: 'd3d12', apiSource: 'dynamic', bitness: 64, renders: true, canonical: 'unreal' }, anticheat: [], installed: false, installedAt: null, installedBuild: null, art: 'afe' },
  { id: 'steam:10680', appid: '10680', store: 'Steam', name: 'Aliens vs. Predator', dir: 'D:\\SteamLibrary\\steamapps\\common\\Aliens vs Predator', exe: { name: 'AvP_DX11.exe', api: 'd3d11', apiSource: 'import', bitness: 32, renders: true, canonical: null }, anticheat: [], installed: true, managed: false, route: 'relay', installedAt: null, installedBuild: '2.2.4-revin4', art: 'avp' },
  { id: 'steam:870780', appid: '870780', store: 'Steam', name: 'Control Ultimate Edition', dir: 'D:\\SteamLibrary\\steamapps\\common\\Control', exe: { name: 'Control_DX12.exe', api: 'd3d12', apiSource: 'import', bitness: 64, renders: true, canonical: null }, anticheat: [], installed: false, installedAt: null, installedBuild: null, art: 'ctrl' },
  { id: 'steam:381210', appid: '381210', store: 'Steam', name: 'Dead by Daylight', dir: 'D:\\SteamLibrary\\steamapps\\common\\Dead by Daylight', exe: { name: 'DeadByDaylight-Win64-Shipping.exe', api: 'd3d12', apiSource: 'dynamic', bitness: 64, renders: true, canonical: 'unreal' }, anticheat: ['EasyAntiCheat'], installed: false, installedAt: null, installedBuild: null, art: null },
  { id: 'steam:2050650', appid: '2050650', store: 'Steam', name: 'Resident Evil 4', dir: 'D:\\SteamLibrary\\steamapps\\common\\RE4', exe: { name: 're4.exe', api: 'd3d12', apiSource: 'import', bitness: 64, renders: true, canonical: null }, anticheat: [], installed: false, installedAt: null, installedBuild: null, art: null },
  { id: 'xbox:Halo Infinite', appid: null, store: 'Xbox', name: 'Halo Infinite', dir: 'C:\\XboxGames\\Halo Infinite\\Content', exe: { name: 'HaloInfinite.exe', api: 'd3d12', apiSource: 'import', bitness: 64, renders: true, canonical: null }, anticheat: [], installed: false, installedAt: null, installedBuild: null, art: 'halo' },
  { id: 'xbox:Forza Horizon 5', appid: null, store: 'Xbox', name: 'Forza Horizon 5', dir: 'C:\\XboxGames\\Forza Horizon 5\\Content', exe: { name: 'ForzaHorizon5.exe', api: 'd3d12', apiSource: 'import', bitness: 64, renders: true, canonical: null }, anticheat: [], installed: false, installedAt: null, installedBuild: null, art: 'forza' },
  { id: 'xbox:Starfield', appid: null, store: 'Xbox', name: 'Starfield', dir: 'C:\\XboxGames\\Starfield\\Content', exe: { name: 'Starfield.exe', api: 'd3d12', apiSource: 'import', bitness: 64, renders: true, canonical: null }, anticheat: [], installed: false, installedAt: null, installedBuild: null, art: null },
  { id: 'manual:E:\\Games\\Some Indie Game', appid: null, store: 'Manual', name: 'Some Indie Game', dir: 'E:\\Games\\Some Indie Game', exe: { name: 'Game.exe', api: 'unknown', apiSource: 'none', bitness: 64, renders: false, canonical: null }, anticheat: [], installed: false, installedAt: null, installedBuild: null, art: null },
];

const activity = [
  { at: new Date(Date.now() - 90e3).toISOString(), level: 'info', message: 'DLSS 5 AIO Installer started - add-on build 2.2.4-revin4' },
  { at: new Date(Date.now() - 88e3).toISOString(), level: 'info', message: 'Found 12 games (8 Steam, 3 Xbox, 1 Manual); 3 with the add-on installed' },
  { at: new Date(Date.now() - 80e3).toISOString(), level: 'info', message: 'Artwork: "Halo Infinite" matched Steam app 1240440 (Halo Infinite)' },
  { at: new Date(Date.now() - 60e3).toISOString(), level: 'warn', message: 'Artwork: nothing on Steam for "Some Indie Game"' },
  { at: new Date(Date.now() - 20e3).toISOString(), level: 'info', message: 'Installed build 2.2.4-revin4 into Grand Theft Auto V Enhanced (4 files, originals backed up)' },
];

function stub() {
  // Runs inside the page before renderer.js; the data token is substituted in.
  const data = __DATA__;
  const byId = Object.fromEntries(data.games.map(g => [g.id, g]));
  const settings = { theme: data.theme, fetchArtwork: true };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const listeners = { activity: [], win: [], media: [], update: [] };
  let updateConsentValue = null;
  let updateStateValue = { state: 'idle' };
  const updateView = () => {
    const view = { enabled: true, consent: updateConsentValue, current: '0.4.0', state: updateStateValue };
    const available = updateStateValue.state === 'available';
    return {
      ...view,
      bar: updateConsentValue === null
        ? { message: 'Look for new versions of this app? When it starts it would ask its official GitHub page (github.com/revingale32/dlss5-aio-installer) for the newest version number, and offer the update when there is one. Nothing else is sent. You can change this any time in Settings.', actions: ['allow', 'deny'] }
        : available ? { message: 'Version 0.4.1 is available - you have 0.4.0. It installs over this one and keeps your settings, games and profiles.', actions: ['download', 'notes', 'later'] }
          : { message: '', actions: [] },
      status: available ? 'Version 0.4.1 is available - you have 0.4.0.' : 'Not checked yet.',
    };
  };
  const mediaDefaults = { style: 0, intensity: 1, tone: 1, structure: 1, skin: -1, autoMask: true, passes: 1, mix: 1, maxWorkMP: 8.3, refine: 1,
    imageFormat: 'png', jpegQuality: 95, codec: 'h264', quality: 'high', audio: 'copy', stabilize: 0.6, motionToNr: false, sceneCut: 0.24,
    suffix: '_dlss5', outputDir: '', monitor: -1, fpsCap: 60 };
  let mediaSettings = { ...mediaDefaults };
  const emitMedia = event => listeners.media.forEach(fn => fn(event));
  const pickedFiles = [
    { source: 'C:\\Users\\you\\Pictures\\Screenshots\\GTA5 sunset.png', name: 'GTA5 sunset.png', kind: 'image', bytes: 6.4e6 },
    { source: 'C:\\Users\\you\\Pictures\\Screenshots\\RE2 hallway.jpg', name: 'RE2 hallway.jpg', kind: 'image', bytes: 1.9e6 },
    { source: 'C:\\Users\\you\\Pictures\\Phone\\IMG_2041.HEIC', name: 'IMG_2041.HEIC', kind: 'image', bytes: 3.1e6 },
    { source: 'C:\\Users\\you\\Videos\\Captures\\drive at night.mp4', name: 'drive at night.mp4', kind: 'video', bytes: 412e6 },
  ];
  const plan = (dir, exeName, profile) => {
    const game = data.games.find(g => g.dir === dir);
    const exe = game.exe;
    const candidates = [exe, { name: 'CrashReportClient.exe', api: 'd3d11', apiSource: 'import', bitness: 64, renders: true, canonical: null, demoted: true }];
    const problems = [];
    const route = exe.bitness === 32 ? 'relay' : 'game';
    const notes = [];
    if (route === 'relay') notes.push(`${exe.name} is 32-bit, so nothing neural runs inside it. A small launcher add-on starts the neural relay beside the game; the relay captures the game window, runs the same add-on on those frames and shows the result in a click-through overlay. Set the game to windowed or borderless (the relay cannot capture exclusive fullscreen). The launcher caps the game at your refresh rate, 90 max, so it does not starve the neural work. Ctrl+Alt+M hands input to the relay so Home opens its menu; Ctrl+Alt+M again gives it back.`);
    if (game.installed && !game.managed) notes.push(`The kit is already here (build ${game.installedBuild}, ${route === 'relay' ? 'relay route' : 'in the game folder'}) but was not installed by this app, so there are no backups yet. Installing from here replaces it with this build and backs up what is there now.`);
    if (!exe.renders) notes.push(`No graphics runtime could be found in ${exe.name}, by import or by name. It may be a launcher rather than the game - check the executable above before installing.`);
    return {
      ok: true,
      plan: {
        gameDir: dir, route, hook: exe.api === 'd3d9' ? 'd3d9.dll' : 'dxgi.dll', exe, candidates,
        files: route === 'relay' ? [
          { to: 'C:\\Users\\you\\AppData\\Local\\RHI\\Custom\\Addons\\nvngx.dll', role: 'NGX caller-identity bridge (machine-wide)', outsideGame: true, shared: true },
          { to: `${dir}\\dxgi.dll`, role: 'ReShade 32-bit (add-on build) - loads the launcher only', outsideGame: false },
          { to: `${dir}\\neural-relay-launcher.addon32`, role: "relay launcher add-on (starts the relay, caps the game's fps)", outsideGame: false },
          { to: `${dir}\\neural-relay\\neural-relay.exe`, role: 'neural relay (64-bit; captures the game window, overlays the result)', outsideGame: false },
          { to: `${dir}\\neural-relay\\dxgi.dll`, role: 'ReShade (add-on build) for the relay', outsideGame: false },
          { to: `${dir}\\neural-relay\\standalone-dlssnr.addon64`, role: 'DLSS 5 neural rendering add-on, run by the relay', outsideGame: false },
          { to: `${dir}\\neural-relay-launcher.ini`, role: 'launcher settings (relay in the neural-relay folder beside the game)', action: 'ini' },
          { to: `${dir}\\neural-relay\\ReShade.ini`, role: "the relay's ReShade settings + the [Standalone.DLSSNR] profile", action: 'ini' },
        ] : [
          { to: 'C:\\Users\\you\\AppData\\Local\\RHI\\Custom\\Addons\\nvngx.dll', role: 'NGX caller-identity bridge (machine-wide)', outsideGame: true, shared: true },
          { to: 'C:\\Users\\you\\AppData\\Local\\RHI\\Custom\\Addons\\nvngx_dlssnr.dll', role: 'NVIDIA neural rendering runtime (copied from your PC, machine-wide)', outsideGame: true, shared: true },
          { to: `${dir}\\dxgi.dll`, role: 'ReShade (add-on build)', outsideGame: false },
          { to: `${dir}\\standalone-dlssnr.addon64`, role: 'DLSS 5 neural rendering add-on', outsideGame: false },
          { to: `${dir}\\ReShade.ini`, role: 'ReShade settings + the [Standalone.DLSSNR] profile', action: 'ini' },
        ],
        profile: { Passes: '1', Model: '1', FrameGeneration: '0', FrameGenMultiplier: '2', ...(profile || {}) },
        problems, notes,
        installable: problems.length === 0,
        alreadyInstalled: game.installed,
        managed: Boolean(game.managed),
        installedBuild: game.installedBuild, installedAt: game.installedAt,
        backupDir: game.installed ? `${dir}\\.dlss5-aio\\backup\\20260913T101502Z` : null,
        runtime: { from: 'C:\\Users\\you\\AppData\\Local\\RHI\\Custom\\Addons', bytes: 158 * 1024 * 1024 },
        machine: data.machine,
        anticheat: game.anticheat,
        anticheatWarning: game.anticheat.length ? `EasyAntiCheat was found in this folder.\n\nThis installer never bypasses anti-cheat. A protected game may refuse to start with ReShade loaded, and an account ban is possible. Only continue if you accept that risk as your own.` : null,
        build: '2.2.4-revin4',
      },
    };
  };
  window.api = {
    listGames: async () => ({ ok: true, games: data.games }),
    addFolder: async () => ({ ok: true, added: null }),
    addDroppedFile: async () => ({ ok: true, added: null }),
    forgetFolder: async () => ({ ok: true }),
    planGame: async (dir, exeName, profile) => plan(dir, exeName, profile),
    installGame: async () => ({ ok: true, manifest: { build: '2.2.4-revin4', files: [], installedAt: new Date().toISOString() } }),
    restoreGame: async () => ({ ok: true, result: { restored: 1, removed: 3, failures: [] } }),
    gameStatus: async () => ({ ok: true, history: [{ at: '2026-09-13T10:15:02Z', action: 'install', build: '2.2.4-revin4' }] }),
    locateRuntimes: async () => ({
      ok: true,
      searched: [
        { dir: 'C:\\Users\\you\\Desktop\\DLSS 5 AIO INSTALLER\\runtimes', found: [] },
        { dir: 'C:\\Users\\you\\AppData\\Local\\RHI\\Custom\\Addons', found: ['nr', 'sr', 'fg'] },
        { dir: 'D:\\SteamLibrary\\steamapps\\common\\RESIDENT EVIL 2  BIOHAZARD RE2', found: ['nr'] },
      ],
      files: { nr: { bytes: 158 * 1024 * 1024, from: 'C:\\Users\\you\\AppData\\Local\\RHI\\Custom\\Addons' }, sr: { bytes: 48 * 1024 * 1024, from: 'C:\\Users\\you\\AppData\\Local\\RHI\\Custom\\Addons' }, fg: null },
      state: { ok: true, message: 'nvngx_dlssnr.dll found (158 MB). Frame generation runtime not found - frame generation will be unavailable until it is.' },
      extraDirs: [],
      machine: data.machine,
    }),
    browseRuntimes: async () => ({ ok: true, added: null }),
    forgetRuntimeDir: async () => ({ ok: true }),
    getCover: async (game, kinds) => {
      await sleep(60);
      const key = byId[game.id] && byId[game.id].art;
      const out = { ok: true, cover: null, hero: null };
      if (!key) return out;
      for (const kind of kinds) out[kind] = { dataUrl: data.art[key][kind], shape: kind === 'cover' ? 'portrait' : 'wide', source: 'cache' };
      return out;
    },
    readLog: async () => ({ ok: true, file: 'C:\\Users\\you\\AppData\\Local\\RHI\\Logs\\standalone-dlssnr.log', reports: [
      { header: '2026-09-13 09:41:12  RESIDENT EVIL 2  BIOHAZARD RE2  standalone-dlssnr 2.2.4-revin4', empty: false, real: 62, output: 120, nr: 5.1, dlaa: 1.9, fg: 2.4, total: 9.4, period: 8.3,
        latency: { total: 41.2, presentToScanout: 18.6 },
        verdicts: [{ name: 'neural queue wait', value: '4.0 ms', verdict: 'high-priority queue is doing its job', good: true }, { name: 'present queue', value: '2.2 frames', verdict: 'deeper than one frame; the cap does not govern a DirectComposition swapchain', good: false }],
        warnings: ['mouse warp is withdrawn in this build and stays off'] },
    ] }),
    getSettings: async () => ({ ok: true, settings }),
    setSettings: async patch => { Object.assign(settings, patch); return { ok: true, settings }; },
    listActivity: async () => ({ ok: true, entries: data.activity }),
    clearActivity: async () => ({ ok: true }),
    copyText: async () => ({ ok: true }),
    windowControl: async () => ({ ok: true, maximized: false }),
    openFolder: async () => ({ ok: true }),
    openLink: async () => ({ ok: true }),
    appInfo: async () => ({ ok: true, version: '0.2.0', build: '2.2.4-revin4', appRoot: 'C:\\Users\\you\\Desktop\\DLSS 5 AIO INSTALLER', settings, maximized: false }),
    mediaReadiness: async () => ({ ok: true, worker: { ok: true }, runtime: { ok: true, version: '310.8.0.0', known: true }, running: { job: null, desktop: null } }),
    mediaGetSettings: async () => ({ ok: true, settings: mediaSettings, defaults: mediaDefaults, workSizes: [0, 8.3, 3.7, 2.1] }),
    mediaSetSettings: async patch => { mediaSettings = { ...mediaSettings, ...patch }; return { ok: true, settings: mediaSettings }; },
    mediaPickFiles: async () => ({ ok: true, files: pickedFiles }),
    mediaAddDropped: async () => ({ ok: true, files: [] }),
    mediaPickOutputDir: async () => ({ ok: true, dir: null }),
    mediaStart: async (mode, files) => {
      const items = files.map(file => ({ input: file, output: file.replace(/\.[^.]+$/, mode === 'video' ? '_dlss5.mp4' : '_dlss5.png') }));
      setTimeout(() => {
        emitMedia({ slot: 'job', event: 'ready', gpu: 'NVIDIA GeForce RTX 5070 Ti', driver: '617.14' });
        if (mode === 'image') {
          emitMedia({ slot: 'job', event: 'file-start', index: 0, input: files[0] });
          emitMedia({ slot: 'job', event: 'file-info', index: 0, width: 3840, height: 2160, workWidth: 3840, workHeight: 2160 });
          emitMedia({ slot: 'job', event: 'file-done', index: 0, input: files[0], output: items[0].output, nrMs: 21.4, change: 0.043 });
          emitMedia({ slot: 'job', event: 'file-start', index: 1, input: files[1] });
          emitMedia({ slot: 'job', event: 'file-info', index: 1, width: 2560, height: 1440, workWidth: 2560, workHeight: 1440 });
          emitMedia({ slot: 'job', event: 'file-done', index: 1, input: files[1], output: items[1].output, nrMs: 9.8, change: 0.051 });
          emitMedia({ slot: 'job', event: 'file-start', index: 2, input: files[2] });
          emitMedia({ slot: 'job', event: 'file-error', index: 2, input: files[2], message: 'Windows has no decoder for this picture format (for HEIC/AVIF/WebP install the matching extension from the Microsoft Store)' });
          emitMedia({ slot: 'job', event: 'exit', ok: false, code: 6 });
        } else {
          emitMedia({ slot: 'job', event: 'file-start', index: 0, input: files[0] });
          emitMedia({ slot: 'job', event: 'file-info', index: 0, width: 2560, height: 1440, workWidth: 2560, workHeight: 1440, fps: 60, seconds: 94 });
          emitMedia({ slot: 'job', event: 'progress', index: 0, frame: 2210, frames: 5640, seconds: 36.8, duration: 94, fps: 41.2, nrMs: 8.6 });
        }
      }, 60);
      return { ok: true, job: 1, items };
    },
    mediaCancel: async () => ({ ok: true }),
    mediaProbe: async () => ({ ok: true, probe: { ok: true, nrMs: 1.9, changedFraction: 0.62 }, ready: { gpu: 'NVIDIA GeForce RTX 5070 Ti', driver: '617.14' } }),
    mediaMonitors: async () => ({ ok: true, monitors: [{ index: 0, width: 2560, height: 1440, primary: true, hdr: true }, { index: 1, width: 1920, height: 1080, primary: false, hdr: false }] }),
    mediaPreview: async file => ({ ok: true, url: /_dlss5/.test(file) ? data.art.re2.hero : data.art.gta.hero }),
    mediaReveal: async () => ({ ok: true }),
    mediaOpen: async () => ({ ok: true }),
    desktopStart: async () => {
      setTimeout(() => {
        emitMedia({ slot: 'desktop', event: 'desktop-ready', width: 2560, height: 1440, workWidth: 2560, workHeight: 1440, hdr: true, motion: true, fpsCap: 60 });
        emitMedia({ slot: 'desktop', event: 'desktop-stats', fps: 55.4, updates: 55.4, ignored: 0, sdrScale: 6, nrMs: 8.5, gpuMs: 8.8, latencyMs: 17.9, frames: 962, visible: true });
      }, 60);
      return { ok: true };
    },
    desktopStop: async () => ({ ok: true }),
    desktopLook: async next => {
      mediaSettings = { ...mediaSettings, ...next };
      setTimeout(() => emitMedia({ slot: 'desktop', event: 'desktop-look', style: mediaSettings.style, passes: mediaSettings.passes,
        intensity: mediaSettings.intensity, tone: mediaSettings.tone, structure: mediaSettings.structure, mix: mediaSettings.mix,
        stabilize: mediaSettings.stabilize, workWidth: 2560, workHeight: 1440, fpsCap: mediaSettings.fpsCap, motion: mediaSettings.stabilize > 0 }), 30);
      return { ok: true, sent: true, settings: mediaSettings };
    },
    desktopSplit: async on => {
      mediaSettings = { ...mediaSettings, split: on };
      setTimeout(() => emitMedia({ slot: 'desktop', event: 'desktop-split', split: on }), 30);
      return { ok: true, sent: true, settings: mediaSettings };
    },
    onMediaEvent: fn => { listeners.media.push(fn); return () => {}; },
    onActivity: fn => { listeners.activity.push(fn); return () => {}; },
    onWindowState: fn => { listeners.win.push(fn); return () => {}; },
    // Updates: first start asks; after "yes" the stand-in pretends 0.4.1 is out.
    updateGet: async () => ({ ok: true, ...updateView() }),
    updateConsent: async allow => {
      updateConsentValue = allow === true;
      updateStateValue = allow ? { state: 'available', version: '0.4.1' } : { state: 'idle' };
      const view = updateView();
      listeners.update.forEach(fn => fn(view));
      return { ok: true, ...view };
    },
    updateCheck: async () => ({ ok: true }),
    updateDownload: async () => ({ ok: true }),
    updateInstall: async () => ({ ok: true }),
    onUpdate: fn => { listeners.update.push(fn); return () => {}; },
  };
}

const machines = {
  blackwell: {
    gpu: { available: true, name: 'NVIDIA GeForce RTX 5070 Ti', driver: '616.92', architecture: 0x1b0, architectureName: 'Blackwell (RTX 50)', source: 'nvidia-smi' },
    hags: { available: true, state: 'on', value: 2 },
    runtimes: {
      nr: { fileVersion: '310.8.0.0', minArchitectureName: 'Blackwell (RTX 50)' },
      sr: { fileVersion: '310.8.0.0', minArchitectureName: 'Turing (RTX 20 / GTX 16)' },
      fg: { fileVersion: '310.8.0.0', minArchitectureName: 'Ada (RTX 40)' },
    },
    verdicts: { nr: { ok: true }, sr: { ok: true }, fg: { ok: true } },
    problems: [], notes: [],
  },
  turing: {
    gpu: { available: true, name: 'NVIDIA GeForce RTX 2080 Ti', driver: '616.92', architecture: 0x160, architectureName: 'Turing (RTX 20 / GTX 16)', source: 'nvidia-smi' },
    hags: { available: true, state: 'off', value: 1 },
    runtimes: {
      nr: { fileVersion: '310.8.0.0', minArchitectureName: 'Blackwell (RTX 50)' },
      sr: { fileVersion: '310.8.0.0', minArchitectureName: 'Turing (RTX 20 / GTX 16)' },
      fg: { fileVersion: '310.8.0.0', minArchitectureName: 'Ada (RTX 40)' },
    },
    verdicts: { nr: { ok: false }, sr: { ok: true }, fg: { ok: false } },
    problems: ["This PC's NVIDIA GeForce RTX 2080 Ti is Turing (RTX 20 / GTX 16). nvngx_dlssnr.dll 310.8.0.0 needs Blackwell (RTX 50) or newer - its kernels do not exist for this card, so neural rendering cannot run here. There is nothing to install."],
    notes: ["This PC's NVIDIA GeForce RTX 2080 Ti is Turing (RTX 20 / GTX 16). nvngx_dlssg.dll 310.8.0.0 needs Ada (RTX 40) or newer - its kernels do not exist for this card, so frame generation cannot run here. It will stay off.",
      'Hardware-accelerated GPU scheduling is off. DLSS frame generation needs it on (Windows Settings > System > Display > Graphics > Default graphics settings), then restart.'],
  },
};

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const buddy = process.argv.includes('--turing');
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
    const data = JSON.stringify({ games, activity, art, theme, machine: buddy ? machines.turing : machines.blackwell });
    await page.addInitScript(`(${stub.toString().replaceAll('__DATA__', data)})();`);
    page.on('pageerror', error => console.error(`[${theme}] page error:`, error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(`[${theme}] console:`, message.text()); });
    await page.goto('file://' + path.join(root, 'ui', 'index.html'));
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, `${theme}-1-home.png`) });
    // The first-start question, then the update offer after "yes".
    await page.click('#update-allow');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(outDir, `${theme}-1b-home-update.png`) });
    await page.click('#update-later');
    await page.waitForTimeout(150);

    await page.click('.nav-item[data-view="library"]');
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(outDir, `${theme}-2-games.png`) });

    await page.click('.scope-btn[data-store="Xbox"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, `${theme}-3-games-xbox.png`) });
    await page.click('.scope-btn[data-store=""]');
    await page.waitForTimeout(300);

    await page.click('.card[data-id="steam:1549970"]');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, `${theme}-4-sheet.png`) });
    await page.locator('#view-game .sheet').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(outDir, `${theme}-4b-sheet-bottom.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    await page.click('.card[data-id="steam:381210"]');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, `${theme}-5-sheet-anticheat.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.click('.card[data-id="steam:10680"]');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, `${theme}-5b-sheet-relay.png`) });
    await page.locator('#view-game .sheet').evaluate(node => { node.scrollTop = 520; });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(outDir, `${theme}-5c-sheet-relay-specs.png`) });
    await page.keyboard.press('Escape');

    await page.click('.nav-item[data-view="media"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, `${theme}-6-media-empty.png`) });
    await page.click('#media-add');
    await page.waitForTimeout(300);
    await page.click('#media-start');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, `${theme}-6-media-queue.png`) });
    await page.locator('#view-media').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(outDir, `${theme}-6-media-queue-bottom.png`) });
    await page.locator('.media-row.is-done button', { hasText: 'Compare' }).first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, `${theme}-6-media-compare.png`) });
    await page.click('#compare-mode button[data-mode="side"]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `${theme}-6-media-compare-side.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.click('#media-tabs button[data-tab="desktop"]');
    await page.waitForTimeout(300);
    await page.click('#desktop-start');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `${theme}-6-media-desktop.png`) });
    // Live changes while it runs: the split, then a stronger look.
    await page.click('#desktop-split');
    await page.selectOption('#ms-style', '2');
    await page.selectOption('#ms-passes', '3');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, `${theme}-6-media-desktop-live.png`) });
    await page.locator('#view-media').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(3500);   // let the toast go
    await page.screenshot({ path: path.join(outDir, `${theme}-6-media-desktop-live-bottom.png`) });
    await page.locator('#view-media').evaluate(node => { node.scrollTop = 0; });

    for (const view of ['runtimes', 'log', 'settings', 'about']) {
      await page.click(`.nav-item[data-view="${view}"]`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(outDir, `${theme}-6-${view}.png`) });
    }
    await page.close();
  }
  await browser.close();
  console.log('shots in', outDir);
})().catch(error => { console.error(error); process.exit(1); });
