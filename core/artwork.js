// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');

// Cover art from Steam's public store, for the games that have none on disk.
//
// Steam's client caches library art only for Steam games, so an Xbox or
// hand-added title has nothing local to show. Steam also publishes the same
// assets for every app id on an open CDN, and its store search resolves a
// title to an id - no account, no key, nothing to register. A Game Pass title
// finds its art as long as the same game also exists on Steam, which is nearly
// all of them.
//
// Everything fetched is written under the app's own covers/ folder, so it is
// fetched once, works offline afterwards, and travels with a portable copy.
// Misses are remembered too, so a game that is not on Steam is not searched
// for again on every launch. The whole thing is optional - one setting turns
// it off and the tiles are drawn instead.

const HOSTS = [
  'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps',
  'https://cdn.cloudflare.steamstatic.com/steam/apps',
];
const FILES = {
  cover: ['library_600x900_2x.jpg', 'library_600x900.jpg'],
  hero: ['library_hero.jpg', 'header.jpg'],
};
const SEARCH = term => `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=us&l=en`;

const RETRY_MISS_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_IMAGE_BYTES = 2000;          // a missing asset comes back as a tiny placeholder, not a 404
const GAP_MS = 350;                    // the store search is rate limited; keep well clear of it

// ---------------------------------------------------------------- names

// Folder names carry edition tags, bracketed notes and separators that no
// store title has. Editions themselves stay - "Definitive Edition" is part of
// the name Steam knows.
function cleanName(name) {
  return String(name || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(repack|fitgirl|dodi|elamigos|codex|rune|empress|plaza|skidrow|multi\d*)\b/gi, ' ')
    .replace(/[_\-–—:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value) {
  return String(value || '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The search for "Control" returns "Star Control" too, so the closest title
// wins rather than the first row, and a row that only shares a word does not
// win at all.
function scoreMatch(query, candidate) {
  const q = normalize(query);
  const n = normalize(candidate);
  if (!q || !n) return 0;
  const qWords = q.split(' ');
  const nWords = n.split(' ');
  const qSet = new Set(qWords);
  const shared = nWords.filter(word => qSet.has(word)).length;
  let score = 0;
  if (n === q) score += 100;
  else if (n.startsWith(q + ' ') || q.startsWith(n + ' ')) score += 60;
  score += (shared / Math.max(qWords.length, 1)) * 40;
  score -= Math.max(0, nWords.length - qWords.length) * 5;
  return score;
}

function pickMatch(rows, query, { threshold = 45 } = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (const row of rows || []) {
    if (!row || (row.type && row.type !== 'app')) continue;
    const score = scoreMatch(query, row.name);
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return best && bestScore >= threshold ? { appid: String(best.id), name: best.name, score: bestScore } : null;
}

// ---------------------------------------------------------------- cache

function cachePaths(cacheDir, appid) {
  return {
    cover: path.join(cacheDir, `${appid}.jpg`),
    hero: path.join(cacheDir, `${appid}_hero.jpg`),
  };
}

function indexFile(cacheDir) { return path.join(cacheDir, 'index.json'); }

function readIndex(cacheDir) {
  try { return JSON.parse(fs.readFileSync(indexFile(cacheDir), 'utf8')) || {}; } catch { return {}; }
}

function writeIndex(cacheDir, index) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = indexFile(cacheDir) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
    fs.renameSync(tmp, indexFile(cacheDir));
    return true;
  } catch { return false; }        // a read-only folder means no memory, not a failure
}

function cachedFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size >= MIN_IMAGE_BYTES ? file : null;
  } catch { return null; }
}

// The app id this game was matched to on an earlier run, if any. Synchronous,
// so the local lookup can use it without waiting on the network path.
function rememberedAppId(cacheDir, gameId) {
  const entry = readIndex(cacheDir)[gameId];
  return entry && entry.appid ? String(entry.appid) : null;
}

// ---------------------------------------------------------------- fetcher

function create({ cacheDir, fetch = globalThis.fetch, now = Date.now, log = () => {} }) {
  if (!cacheDir) throw new Error('artwork.create needs a cacheDir');
  let chain = Promise.resolve();
  let lastCall = 0;

  // One request at a time, spaced out, however many tiles ask at once.
  function queued(work) {
    const run = chain.then(async () => {
      const wait = GAP_MS - (now() - lastCall);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      lastCall = now();
      return work();
    });
    chain = run.catch(() => {});
    return run;
  }

  async function getJson(url) {
    if (typeof fetch !== 'function') throw new Error('no fetch available');
    const response = await queued(() => fetch(url, { headers: { 'Accept-Language': 'en' } }));
    if (!response.ok) throw new Error(`Steam replied ${response.status}`);
    return response.json();
  }

  async function download(url, dest) {
    if (typeof fetch !== 'function') throw new Error('no fetch available');
    const response = await queued(() => fetch(url));
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < MIN_IMAGE_BYTES) return null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dest);
    return dest;
  }

  // Which Steam app this game is. Steam's own games already know; anything
  // else is searched for once and the answer - or the lack of one - kept.
  async function resolveAppId(game) {
    if (game.appid) return { appid: String(game.appid), name: game.name, source: 'store' };
    const index = readIndex(cacheDir);
    const known = index[game.id];
    if (known && known.appid) return { appid: String(known.appid), name: known.name || game.name, source: 'remembered' };
    if (known && !known.appid && known.at && now() - Date.parse(known.at) < RETRY_MISS_AFTER_MS) {
      return null;                                     // asked recently, Steam had nothing
    }
    const term = cleanName(game.name);
    let match = null;
    if (term) {
      try {
        const json = await getJson(SEARCH(term));
        match = pickMatch(json && json.items, term);
      } catch (error) {
        log(`Artwork: search for "${term}" failed - ${error.message}`);
        return null;                                   // do not record a miss for a network failure
      }
    }
    const fresh = readIndex(cacheDir);
    fresh[game.id] = match
      ? { appid: match.appid, name: match.name, at: new Date(now()).toISOString() }
      : { appid: null, at: new Date(now()).toISOString() };
    writeIndex(cacheDir, fresh);
    if (match) log(`Artwork: "${game.name}" matched Steam app ${match.appid} (${match.name})`);
    else log(`Artwork: nothing on Steam for "${game.name}"`);
    return match ? { appid: match.appid, name: match.name, source: 'search' } : null;
  }

  async function fetchKind(appid, kind) {
    const dest = cachePaths(cacheDir, appid)[kind];
    const have = cachedFile(dest);
    if (have) return have;
    const index = readIndex(cacheDir);
    const missKey = `missing:${appid}:${kind}`;
    const miss = index[missKey];
    if (miss && miss.at && now() - Date.parse(miss.at) < RETRY_MISS_AFTER_MS) return null;
    for (const file of FILES[kind]) {
      for (const host of HOSTS) {
        try {
          const saved = await download(`${host}/${appid}/${file}`, dest);
          if (saved) return saved;
        } catch (error) {
          log(`Artwork: ${file} for ${appid} failed - ${error.message}`);
          return null;                                 // network trouble: try again next launch
        }
      }
    }
    const fresh = readIndex(cacheDir);
    fresh[missKey] = { at: new Date(now()).toISOString() };
    writeIndex(cacheDir, fresh);
    return null;
  }

  // Both pictures for one game, from the cache or the CDN. Never throws: art
  // is decoration, and a tile with no picture is a normal outcome.
  async function fetchArt(game, { kinds = ['cover', 'hero'] } = {}) {
    try {
      const resolved = await resolveAppId(game);
      if (!resolved) return { appid: null, cover: null, hero: null };
      const result = { appid: resolved.appid, matched: resolved.name, cover: null, hero: null };
      for (const kind of kinds) result[kind] = await fetchKind(resolved.appid, kind);
      return result;
    } catch (error) {
      log(`Artwork: ${game.name} - ${error.message}`);
      return { appid: null, cover: null, hero: null };
    }
  }

  return { fetchArt, resolveAppId, cacheDir };
}

module.exports = {
  create, cleanName, normalize, scoreMatch, pickMatch,
  cachePaths, readIndex, writeIndex, rememberedAppId, cachedFile,
  HOSTS, FILES, MIN_IMAGE_BYTES, RETRY_MISS_AFTER_MS,
};
