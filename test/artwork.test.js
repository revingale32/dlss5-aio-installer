// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const artwork = require('../core/artwork');
const covers = require('../core/covers');
const profiles = require('../core/profiles');
const activity = require('../core/activity');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-art-')); }

// A stand-in for fetch that answers from a table and records every URL asked
// for. The tests never touch the network.
function fakeFetch(table) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const hit = Object.entries(table).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    const body = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
    if (body === null) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true, status: 200,
      json: async () => body,
      arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))).buffer.slice(0),
    };
  };
  return { fetch, calls };
}

const JPEG = Buffer.alloc(5000, 1);      // big enough to count as a picture

// ---------------------------------------------------------------- matching

test('cleanName drops scene tags, brackets and separators but keeps editions', () => {
  assert.strictEqual(artwork.cleanName('Mafia - Definitive Edition [FitGirl Repack]'), 'Mafia Definitive Edition');
  assert.strictEqual(artwork.cleanName('Control_Ultimate_Edition (v1.14)'), 'Control Ultimate Edition');
  assert.strictEqual(artwork.cleanName('  '), '');
});

test('the closest title wins, and a partial word overlap does not', () => {
  const rows = [
    { id: 1, name: 'Star Control: Origins', type: 'app' },
    { id: 2, name: 'Control Ultimate Edition', type: 'app' },
    { id: 3, name: 'Control Soundtrack', type: 'dlc' },
  ];
  assert.strictEqual(artwork.pickMatch(rows, 'Control').appid, '2');
  assert.strictEqual(artwork.pickMatch([rows[0]], 'Control'), null, 'Star Control only shares a word');
  assert.strictEqual(artwork.pickMatch([{ id: 9, name: 'Aliens: Fireteam Elite' }], 'Aliens Fireteam Elite').appid, '9');
  assert.strictEqual(artwork.pickMatch([{ id: 4, name: 'Call of Duty®' }], 'Call of Duty').appid, '4');
  assert.strictEqual(artwork.pickMatch([], 'anything'), null);
});

// ---------------------------------------------------------------- fetching

test('a Steam game skips the search and both pictures land in the cache', async () => {
  const dir = tmp();
  const { fetch, calls } = fakeFetch({
    'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/271590/library_600x900_2x.jpg': JPEG,
    'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/271590/library_hero.jpg': JPEG,
  });
  let clock = 1_000_000;
  const art = artwork.create({ cacheDir: dir, fetch, now: () => (clock += 400) });
  const result = await art.fetchArt({ id: 'steam:271590', appid: '271590', store: 'Steam', name: 'Grand Theft Auto V' });
  assert.strictEqual(result.appid, '271590');
  assert.ok(fs.existsSync(path.join(dir, '271590.jpg')));
  assert.ok(fs.existsSync(path.join(dir, '271590_hero.jpg')));
  assert.ok(!calls.some(url => url.includes('storesearch')), 'no search for a game that knows its id');

  // Second time round nothing is fetched at all.
  const before = calls.length;
  await art.fetchArt({ id: 'steam:271590', appid: '271590', store: 'Steam', name: 'Grand Theft Auto V' });
  assert.strictEqual(calls.length, before);
});

test('an Xbox game is searched for once, the match remembered, and a miss not retried', async () => {
  const dir = tmp();
  const { fetch, calls } = fakeFetch({
    'https://store.steampowered.com/api/storesearch/?term=Halo%20Infinite': { items: [{ id: 1240440, name: 'Halo Infinite', type: 'app' }] },
    'https://store.steampowered.com/api/storesearch/?term=Nowhere%20Game': { items: [] },
    'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1240440/library_600x900_2x.jpg': JPEG,
    'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1240440/library_hero.jpg': null,
    'https://cdn.cloudflare.steamstatic.com/steam/apps/1240440/library_hero.jpg': null,
    'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1240440/header.jpg': JPEG,
  });
  let clock = 5_000_000;
  const messages = [];
  const art = artwork.create({ cacheDir: dir, fetch, now: () => (clock += 400), log: m => messages.push(m) });

  const halo = await art.fetchArt({ id: 'xbox:Halo Infinite', store: 'Xbox', name: 'Halo Infinite' });
  assert.strictEqual(halo.appid, '1240440');
  assert.ok(halo.cover && halo.hero, 'hero fell through to header.jpg');
  assert.strictEqual(artwork.rememberedAppId(dir, 'xbox:Halo Infinite'), '1240440');

  const searches = () => calls.filter(url => url.includes('storesearch')).length;
  assert.strictEqual(searches(), 1);
  await art.fetchArt({ id: 'xbox:Halo Infinite', store: 'Xbox', name: 'Halo Infinite' });
  assert.strictEqual(searches(), 1, 'the remembered id is used, not searched again');

  const nowhere = await art.fetchArt({ id: 'manual:D:\\Games\\Nowhere Game', store: 'Manual', name: 'Nowhere Game' });
  assert.strictEqual(nowhere.appid, null);
  assert.strictEqual(searches(), 2);
  await art.fetchArt({ id: 'manual:D:\\Games\\Nowhere Game', store: 'Manual', name: 'Nowhere Game' });
  assert.strictEqual(searches(), 2, 'a fresh miss is not asked again');
  assert.ok(messages.some(m => /nothing on Steam/.test(m)));
});

test('a network failure is not recorded as a miss', async () => {
  const dir = tmp();
  const fetch = async () => { throw new Error('offline'); };
  const art = artwork.create({ cacheDir: dir, fetch });
  const result = await art.fetchArt({ id: 'xbox:Forza', store: 'Xbox', name: 'Forza Horizon 5' });
  assert.strictEqual(result.appid, null);
  assert.deepStrictEqual(artwork.readIndex(dir), {}, 'nothing written for a failure');
});

test('a tiny response is a placeholder, not a picture', async () => {
  const dir = tmp();
  const { fetch } = fakeFetch({ 'https://': Buffer.alloc(100) });
  const art = artwork.create({ cacheDir: dir, fetch });
  const result = await art.fetchArt({ id: 'steam:1', appid: '1', store: 'Steam', name: 'x' }, { kinds: ['cover'] });
  assert.strictEqual(result.cover, null);
  assert.ok(!fs.existsSync(path.join(dir, '1.jpg')));
});

test('requests are spaced out, however many tiles ask at once', async () => {
  const dir = tmp();
  const stamps = [];
  const fetch = async () => { stamps.push(Date.now()); return { ok: true, status: 200, arrayBuffer: async () => JPEG.buffer.slice(0), json: async () => ({}) }; };
  const art = artwork.create({ cacheDir: dir, fetch });
  await Promise.all([1, 2, 3].map(id => art.fetchArt({ id: `steam:${id}`, appid: String(id), store: 'Steam', name: 'x' }, { kinds: ['cover'] })));
  for (let index = 1; index < stamps.length; index++) {
    assert.ok(stamps[index] - stamps[index - 1] >= 300, `calls ${index - 1} and ${index} were ${stamps[index] - stamps[index - 1]} ms apart`);
  }
});

// ---------------------------------------------------------------- locating

test('covers.locate prefers a user-supplied file, then the cache, then Steam', () => {
  const app = tmp();
  const steam = tmp();
  const game = { id: 'steam:10', appid: '10', store: 'Steam', name: 'Ten', dir: tmp() };
  const cacheDir = path.join(app, 'covers');
  const options = { steamRoots: [steam], appRoot: app, cacheDir };

  assert.strictEqual(covers.locate(game, options), null);

  const steamFile = path.join(steam, 'appcache', 'librarycache', '10', 'library_600x900.jpg');
  fs.mkdirSync(path.dirname(steamFile), { recursive: true });
  fs.writeFileSync(steamFile, JPEG);
  assert.strictEqual(covers.locate(game, options).source, 'steam');

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, '10.jpg'), JPEG);
  assert.strictEqual(covers.locate(game, options).source, 'cache');

  fs.writeFileSync(path.join(game.dir, 'cover.png'), JPEG);
  assert.strictEqual(covers.locate(game, options).source, 'local');
});

test('a non-Steam game finds its cached art through the remembered id', () => {
  const app = tmp();
  const cacheDir = path.join(app, 'covers');
  artwork.writeIndex(cacheDir, { 'xbox:Halo Infinite': { appid: '1240440', name: 'Halo Infinite', at: new Date().toISOString() } });
  fs.writeFileSync(path.join(cacheDir, '1240440.jpg'), JPEG);
  fs.writeFileSync(path.join(cacheDir, '1240440_hero.jpg'), JPEG);
  const game = { id: 'xbox:Halo Infinite', store: 'Xbox', name: 'Halo Infinite', dir: tmp() };
  assert.strictEqual(covers.locate(game, { appRoot: app, cacheDir }).source, 'cache');
  assert.strictEqual(covers.locateHero(game, { appRoot: app, cacheDir }).shape, 'wide');
});

test('readAsDataUrl refuses anything that is not a small image', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.jpg');
  fs.writeFileSync(file, JPEG);
  assert.match(covers.readAsDataUrl(file), /^data:image\/jpeg;base64,/);
  assert.strictEqual(covers.readAsDataUrl(file, { maxBytes: 10 }), null);
  fs.writeFileSync(path.join(dir, 'x.exe'), JPEG);
  assert.strictEqual(covers.readAsDataUrl(path.join(dir, 'x.exe')), null);
});

// ---------------------------------------------------------------- settings + activity

test('settings keep only known keys and shapes', () => {
  const app = tmp();
  assert.deepStrictEqual(profiles.readSettings(app), { theme: 'dark', fetchArtwork: true, allowUnknownRuntime: false, checkUpdates: null },
    'update checks start as "not asked yet"');
  profiles.writeSettings(app, { theme: 'light', fetchArtwork: false, allowUnknownRuntime: true, checkUpdates: true, evil: 'x', theme2: 'y' });
  assert.deepStrictEqual(profiles.readSettings(app), { theme: 'light', fetchArtwork: false, allowUnknownRuntime: true, checkUpdates: true });
  profiles.writeSettings(app, { theme: 'purple', fetchArtwork: 'yes', allowUnknownRuntime: 'sure', checkUpdates: 'please' });
  assert.deepStrictEqual(profiles.readSettings(app), { theme: 'light', fetchArtwork: false, allowUnknownRuntime: true, checkUpdates: true }, 'bad values are ignored');
  profiles.writeSettings(app, { checkUpdates: false });
  assert.strictEqual(profiles.readSettings(app).checkUpdates, false, 'no is remembered as no, not as "not asked"');
  assert.ok(!('evil' in profiles.read(app).settings));
});

test('runtime folders can be forgotten as well as added', () => {
  const app = tmp();
  const dir = tmp();
  profiles.addRuntimeDir(app, dir);
  assert.deepStrictEqual(profiles.readRuntimeDirs(app), [dir]);
  profiles.removeRuntimeDir(app, dir.toUpperCase());
  assert.deepStrictEqual(profiles.readRuntimeDirs(app), []);
});

test('the activity log keeps order, caps its length and prints plainly', () => {
  let tick = 0;
  // Local time on purpose: the log prints the PC's own clock, not UTC.
  const log = activity.create({ limit: 3, now: () => new Date(2026, 8, 13, 12, 0, tick++) });
  const seen = [];
  log.onEntry(entry => seen.push(entry.message));
  log.info('one'); log.warn('two'); log.info('three'); log.error('four');
  assert.deepStrictEqual(log.list().map(e => e.message), ['two', 'three', 'four']);
  assert.deepStrictEqual(seen, ['one', 'two', 'three', 'four']);
  assert.strictEqual(log.text(), '[12:00:01] WARN two\n[12:00:02] three\n[12:00:03] ERROR four');
  log.clear();
  assert.deepStrictEqual(log.list(), []);
});
