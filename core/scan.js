// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vdf = require('./vdf');
const pe = require('./pe');

// ---------------------------------------------------------------- Steam

function steamRootsFromRegistry() {
  if (process.platform !== 'win32') return [];
  const roots = [];
  for (const key of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
    for (const value of ['SteamPath', 'InstallPath']) {
      try {
        const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', timeout: 5000 });
        const match = out.match(/REG_SZ\s+(.+)/);
        if (match) roots.push(match[1].trim().replace(/\//g, '\\'));
      } catch { /* key absent: normal */ }
    }
  }
  return roots;
}

function steamRoots() {
  const found = new Set();
  for (const root of steamRootsFromRegistry()) found.add(root);
  for (const guess of [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'),
  ]) {
    if (guess && fs.existsSync(path.join(guess, 'steamapps'))) found.add(guess);
  }
  return [...found].filter(root => fs.existsSync(path.join(root, 'steamapps')));
}

// Every library Steam knows about, including drives the user added later.
function steamLibraries(roots = steamRoots()) {
  const libraries = new Set();
  for (const root of roots) {
    libraries.add(path.join(root, 'steamapps'));
    for (const candidate of [
      path.join(root, 'steamapps', 'libraryfolders.vdf'),
      path.join(root, 'config', 'libraryfolders.vdf'),
    ]) {
      let text;
      try { text = fs.readFileSync(candidate, 'utf8'); } catch { continue; }
      const list = vdf.get(vdf.parse(text), 'libraryfolders') || {};
      for (const key of Object.keys(list)) {
        const entry = list[key];
        const libPath = typeof entry === 'string' ? entry : vdf.get(entry, 'path');
        if (!libPath) continue;
        const steamapps = path.join(libPath, 'steamapps');
        if (fs.existsSync(steamapps)) libraries.add(steamapps);
      }
    }
  }
  return [...libraries];
}

function steamGames(libraries = steamLibraries()) {
  const games = [];
  const seen = new Set();
  for (const steamapps of libraries) {
    let entries;
    try { entries = fs.readdirSync(steamapps); } catch { continue; }
    for (const entry of entries) {
      if (!/^appmanifest_\d+\.acf$/i.test(entry)) continue;
      let state;
      try {
        state = vdf.get(vdf.parse(fs.readFileSync(path.join(steamapps, entry), 'utf8')), 'AppState');
      } catch { continue; }
      if (!state) continue;
      const appid = String(vdf.get(state, 'appid') || '');
      const installdir = vdf.get(state, 'installdir');
      if (!appid || !installdir || seen.has(appid)) continue;
      const dir = path.join(steamapps, 'common', installdir);
      if (!fs.existsSync(dir)) continue;          // manifest without the files
      seen.add(appid);
      games.push({
        id: `steam:${appid}`,
        store: 'Steam',
        appid,
        name: vdf.get(state, 'name') || installdir,
        dir,
      });
    }
  }
  return games;
}

// ---------------------------------------------------------------- Xbox / Game Pass

// Game Pass titles land in a `XboxGames` folder per drive, each with the real
// game under `Content`. The folder is ACL-locked while installed, which is why
// installs there need the app run as administrator - the scan itself is fine.
function xboxGames() {
  const games = [];
  for (const drive of driveLetters()) {
    const root = `${drive}:\\XboxGames`;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const content = path.join(root, entry.name, 'Content');
      if (!fs.existsSync(content)) continue;
      games.push({
        id: `xbox:${entry.name}`,
        store: 'Xbox',
        name: entry.name,
        dir: content,
      });
    }
  }
  return games;
}

function driveLetters() {
  if (process.platform !== 'win32') return [];
  const letters = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const letter = String.fromCharCode(code);
    try { if (fs.existsSync(`${letter}:\\`)) letters.push(letter); } catch { /* ignore */ }
  }
  return letters;
}

// ---------------------------------------------------------------- executables

// Folders that never hold the renderer, and are sometimes enormous.
const SKIP_DIRS = new Set([
  '_mod_backup', 'redist', 'redistributables', 'directx', 'd3d-redist', '_commonredist',
  'reshade-shaders', 'easyanticheat', 'easyanticheat_eos', 'battleye', 'video', 'movies',
  'fmv', 'sounds', 'audio', 'zone', 'data', 'assets', 'characters', 'envs', 'logs',
]);

// Names that are a launcher, a crash handler or an anti-cheat shim rather than
// the game. These are demoted, never hidden: a wrong guess should still be
// selectable in the UI.
const DEMOTE = /(launcher|crash|report|setup|unins|redist|vcredist|dxsetup|touchup|activation|helper|updater|cleanup|benchmark|editor|server|dedicated|_be\b|battleye|eac|anticheat|start_protected_game)/i;

function findExecutables(dir, { maxDepth = 3, maxEntries = 4000 } = {}) {
  const found = [];
  let budget = maxEntries;
  (function walk(current, depth) {
    if (depth > maxDepth || budget <= 0) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.exe$/i.test(entry.name)) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      const unityData = fs.existsSync(path.join(current, `${entry.name.replace(/\.exe$/i, '')}_Data`));
      found.push({ file: full, name: entry.name, size, depth, unityData });
    }
  })(dir, 0);
  return found;
}

// Rank already-inspected candidates. Pure, so the real-world cases (a launcher
// beside the game, an anti-cheat shim, a DX9 and a DX11 build in one folder)
// are unit-testable without needing the games present.
//
// The signal that matters is whether the executable actually imports a graphics
// runtime: a launcher does not, no matter what it is called or how big it is.
// Engines put the real executable somewhere predictable, and that beats every
// heuristic. Unreal in particular ships a tiny launcher shim in the root, the
// game under <Project>/Binaries/Win64, and a crash reporter that - unlike the
// game - imports d3d11 directly, so without this the crash reporter wins.
function engineCanonical(entry) {
  const full = String(entry.file || entry.name).replace(/\\/g, '/');
  // Unreal: <Project>/Binaries/Win64/<Project>-Win64-Shipping.exe
  if (/\/Binaries\/Win(64|32)\/[^/]+-Win(64|32)-Shipping\.exe$/i.test(full)) return 'unreal';
  // Unity: <Name>.exe beside <Name>_Data
  if (entry.unityData) return 'unity';
  return null;
}

function rankCandidates(entries) {
  const ranked = entries.map(entry => {
    const renders = entry.api !== 'unknown';
    const demoted = DEMOTE.test(entry.name);
    const canonical = engineCanonical(entry);
    let score = 0;
    if (canonical) score += 4000;            // the engine says so; nothing outranks that
    if (renders) score += 1000;
    // An import is proof; a string is a hint. AvP's launcher mentions d3d11.dll
    // because it is the DX9/DX11 chooser, not because it draws anything.
    if (entry.apiSource === 'import') score += 300;
    if (['d3d12', 'd3d11', 'vulkan'].includes(entry.api)) score += 200;
    if (demoted) score -= 2500;              // must stay below any non-demoted candidate
    score += Math.min(300, Math.round((entry.size || 0) / (1024 * 1024)));  // bigger = more likely the game
    score -= (entry.depth || 0) * 25;
    return { ...entry, renders, demoted, canonical, score };
  });
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked;
}

function rankExecutables(dir, options) {
  const inspected = [];
  for (const candidate of findExecutables(dir, options)) {
    const info = pe.inspect(candidate.file);
    if (!info.bitness) continue;
    inspected.push({
      file: candidate.file,
      name: candidate.name,
      dir: path.dirname(candidate.file),
      size: candidate.size,
      depth: candidate.depth,
      unityData: candidate.unityData,
      bitness: info.bitness,
      api: info.api,
      apiSource: info.apiSource,
    });
  }
  return rankCandidates(inspected);
}

// A demoted name is never preferred over a plain one, whatever else it has
// going for it. Unreal's CrashReportClient imports d3d11 while the game itself
// imports nothing, and "it renders" used to be enough to select it.
function pickBest(ranked) {
  return ranked.find(entry => entry.canonical)
    || ranked.find(entry => entry.renders && !entry.demoted)
    || ranked.find(entry => !entry.demoted)
    || ranked[0]
    || null;
}

function chooseExecutable(dir, options) {
  const ranked = rankExecutables(dir, options);
  return { chosen: pickBest(ranked), candidates: ranked };
}

function scanAll() {
  const games = [...steamGames(), ...xboxGames()];
  games.sort((a, b) => a.name.localeCompare(b.name));
  return games;
}

module.exports = {
  steamRoots, steamLibraries, steamGames, xboxGames, driveLetters,
  findExecutables, rankCandidates, rankExecutables, pickBest, chooseExecutable, scanAll, engineCanonical,
};
