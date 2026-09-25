// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// App-level state: the games the user added by hand, extra folders to look for
// NVIDIA runtimes in, and the last settings used per game.
//
// All of it lives in one JSON file beside the app, so a portable copy carries
// its own state and deleting the folder leaves nothing behind on the machine.

function stateFile(appRoot) {
  return path.join(appRoot, 'settings.json');
}

function read(appRoot) {
  try { return JSON.parse(fs.readFileSync(stateFile(appRoot), 'utf8')); } catch { return {}; }
}

function write(appRoot, state) {
  try {
    fs.writeFileSync(stateFile(appRoot), JSON.stringify(state, null, 2));
    return true;
  } catch { return false; }        // a read-only install folder must not break the app
}

function keyFor(dir) {
  return crypto.createHash('sha1').update(String(dir).toLowerCase()).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- per-game profiles

function readProfile(appRoot, dir) {
  const state = read(appRoot);
  return (state.profiles && state.profiles[keyFor(dir)] && state.profiles[keyFor(dir)].values) || {};
}

function writeProfile(appRoot, dir, values) {
  const state = read(appRoot);
  state.profiles = state.profiles || {};
  state.profiles[keyFor(dir)] = { dir, values, savedAt: new Date().toISOString() };
  return write(appRoot, state);
}

function listProfiles(appRoot) {
  const state = read(appRoot);
  return Object.values(state.profiles || {});
}

// ---------------------------------------------------------------- manual games

function readManualGames(appRoot) {
  const state = read(appRoot);
  return (state.manualGames || []).filter(game => {
    try { return fs.existsSync(game.dir); } catch { return false; }
  });
}

function addManualGame(appRoot, game) {
  const state = read(appRoot);
  state.manualGames = state.manualGames || [];
  if (!state.manualGames.some(entry => entry.dir.toLowerCase() === game.dir.toLowerCase())) {
    state.manualGames.push(game);
  }
  return write(appRoot, state);
}

function removeManualGame(appRoot, dir) {
  const state = read(appRoot);
  state.manualGames = (state.manualGames || []).filter(entry => entry.dir.toLowerCase() !== String(dir).toLowerCase());
  return write(appRoot, state);
}

// ---------------------------------------------------------------- runtime folders

function readRuntimeDirs(appRoot) {
  return (read(appRoot).runtimeDirs || []).filter(dir => {
    try { return fs.existsSync(dir); } catch { return false; }
  });
}

function addRuntimeDir(appRoot, dir) {
  const state = read(appRoot);
  state.runtimeDirs = state.runtimeDirs || [];
  if (!state.runtimeDirs.some(entry => entry.toLowerCase() === String(dir).toLowerCase())) {
    state.runtimeDirs.push(dir);
  }
  return write(appRoot, state);
}

function removeRuntimeDir(appRoot, dir) {
  const state = read(appRoot);
  state.runtimeDirs = (state.runtimeDirs || []).filter(entry => entry.toLowerCase() !== String(dir).toLowerCase());
  return write(appRoot, state);
}

// ---------------------------------------------------------------- app settings

// How the app itself behaves. Only these keys, only these shapes: anything else
// in the request is dropped rather than stored, so a bad renderer cannot grow
// the file.
const SETTING_DEFAULTS = {
  theme: 'dark',              // 'dark' | 'light'
  fetchArtwork: true,         // ask Steam's public store for missing covers
  allowUnknownRuntime: false, // install with an nvngx_dlssnr.dll whose hash is not on the validated list
  checkUpdates: null,         // null = not asked yet, true = look for a new release on start, false = don't
};

function readSettings(appRoot) {
  const stored = read(appRoot).settings || {};
  const settings = { ...SETTING_DEFAULTS };
  if (stored.theme === 'light' || stored.theme === 'dark') settings.theme = stored.theme;
  if (typeof stored.fetchArtwork === 'boolean') settings.fetchArtwork = stored.fetchArtwork;
  if (typeof stored.allowUnknownRuntime === 'boolean') settings.allowUnknownRuntime = stored.allowUnknownRuntime;
  if (typeof stored.checkUpdates === 'boolean') settings.checkUpdates = stored.checkUpdates;
  return settings;
}

function writeSettings(appRoot, patch) {
  const state = read(appRoot);
  const next = readSettings(appRoot);
  if (patch && (patch.theme === 'light' || patch.theme === 'dark')) next.theme = patch.theme;
  if (patch && typeof patch.fetchArtwork === 'boolean') next.fetchArtwork = patch.fetchArtwork;
  if (patch && typeof patch.allowUnknownRuntime === 'boolean') next.allowUnknownRuntime = patch.allowUnknownRuntime;
  if (patch && typeof patch.checkUpdates === 'boolean') next.checkUpdates = patch.checkUpdates;
  state.settings = next;
  write(appRoot, state);
  return next;
}

module.exports = {
  stateFile, read, write, keyFor,
  readProfile, writeProfile, listProfiles,
  readManualGames, addManualGame, removeManualGame,
  readRuntimeDirs, addRuntimeDir, removeRuntimeDir,
  readSettings, writeSettings, SETTING_DEFAULTS,
};
