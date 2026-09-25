// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');
const artwork = require('./artwork');

// Cover art, from the machine's own disk.
//
// Three places can have a picture for a game, tried in this order:
//   1. one the user put there themselves - cover.jpg beside the game, or a
//      file named after the game in the app's covers/ folder;
//   2. the app's own covers/ cache, filled by core/artwork.js on an earlier run;
//   3. Steam's client cache, which already holds library art for every Steam
//      game (Steam has moved that cache at least twice, so every known layout
//      is tried).
// A miss is a normal outcome, not an error: the UI draws its own tile instead,
// and may go and fetch one if that setting is on.

const PORTRAIT = ['library_600x900_2x.jpg', 'library_600x900.jpg'];
const WIDE = ['library_hero.jpg', 'header.jpg', 'hero_capsule.jpg'];

// Newer Steam: appcache/librarycache/<appid>/library_600x900.jpg
// Older Steam: appcache/librarycache/<appid>_library_600x900.jpg
function candidatePaths(steamRoot, appid, names = [...PORTRAIT, ...WIDE]) {
  const cache = path.join(steamRoot, 'appcache', 'librarycache');
  const paths = [];
  for (const name of names) {
    const shape = PORTRAIT.includes(name) ? 'portrait' : 'wide';
    paths.push({ file: path.join(cache, String(appid), name), shape });
    paths.push({ file: path.join(cache, `${appid}_${name}`), shape });
  }
  return paths;
}

function usable(file, minBytes) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > minBytes ? stat.size : 0;
  } catch { return 0; }
}

function findSteamCover(steamRoots, appid, names) {
  if (!appid) return null;
  for (const root of steamRoots) {
    for (const candidate of candidatePaths(root, appid, names)) {
      const bytes = usable(candidate.file, 1024);
      if (bytes) return { ...candidate, bytes };
    }
  }
  return null;
}

function safeName(value) {
  return String(value || '').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 64);
}

// A cover the user dropped next to the game, or into the app's covers folder
// named by the game id or name.
function findLocalCover(appRoot, game, stem = 'cover') {
  const exts = ['.jpg', '.png', '.jpeg', '.webp'];
  const places = [game.dir, path.join(appRoot, 'covers')].filter(Boolean);
  const stems = [safeName(game.id), safeName(game.name)].filter(Boolean);
  for (const dir of places) {
    for (const ext of exts) {
      const files = [path.join(dir, `${stem}${ext}`)];
      if (stem === 'cover') files.push(...stems.map(name => path.join(dir, `${name}${ext}`)));
      else files.push(...stems.map(name => path.join(dir, `${name}_${stem}${ext}`)));
      for (const file of files) {
        const bytes = usable(file, 512);
        if (bytes) return { file, shape: stem === 'cover' ? 'portrait' : 'wide', bytes };
      }
    }
  }
  return null;
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// The page has no filesystem, so art crosses as a data URL. A cover is a few
// hundred KB at most; anything larger than this is not library art and is
// refused rather than dragged through IPC.
function readAsDataUrl(file, { maxBytes = 3 * 1024 * 1024 } = {}) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime) return null;
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch { return null; }
}

function appIdFor(game, cacheDir) {
  if (game.appid) return String(game.appid);
  return cacheDir ? artwork.rememberedAppId(cacheDir, game.id) : null;
}

function locate(game, { steamRoots = [], appRoot = null, cacheDir = null } = {}) {
  const local = appRoot ? findLocalCover(appRoot, game, 'cover') : null;
  if (local) return { ...local, source: 'local' };
  const appid = appIdFor(game, cacheDir);
  if (appid && cacheDir) {
    const cached = artwork.cachePaths(cacheDir, appid).cover;
    const bytes = usable(cached, 1024);
    if (bytes) return { file: cached, shape: 'portrait', bytes, source: 'cache' };
  }
  if (game.store === 'Steam' && appid) {
    const steam = findSteamCover(steamRoots, appid, PORTRAIT);
    if (steam) return { ...steam, source: 'steam' };
  }
  return null;
}

// The wide banner behind the game sheet. Same three places, wide shapes only.
function locateHero(game, { steamRoots = [], appRoot = null, cacheDir = null } = {}) {
  const local = appRoot ? findLocalCover(appRoot, game, 'hero') : null;
  if (local) return { ...local, source: 'local' };
  const appid = appIdFor(game, cacheDir);
  if (appid && cacheDir) {
    const cached = artwork.cachePaths(cacheDir, appid).hero;
    const bytes = usable(cached, 1024);
    if (bytes) return { file: cached, shape: 'wide', bytes, source: 'cache' };
  }
  if (game.store === 'Steam' && appid) {
    const steam = findSteamCover(steamRoots, appid, WIDE);
    if (steam) return { ...steam, source: 'steam' };
  }
  return null;
}

module.exports = {
  locate, locateHero, findSteamCover, findLocalCover, readAsDataUrl, candidatePaths, safeName, appIdFor,
  PORTRAIT, WIDE,
};
