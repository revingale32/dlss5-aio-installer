// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// A UI nobody can open from here still has to hold together. These are static
// checks over the three files that have to agree with each other: the page
// calls window.api.X, the preload bridge exposes X and maps it to a channel,
// and the main process handles that channel. A mismatch in any direction is a
// button that silently does nothing, which is exactly the failure that is
// invisible until someone clicks it.

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const rendererSource = read(path.join('ui', 'renderer.js'));
const preloadSource = read('preload.js');
const mainSource = read('main.js');
const htmlSource = read(path.join('ui', 'index.html'));
const cssSource = read(path.join('ui', 'style.css'));

function matchAll(source, pattern, group = 1) {
  return [...source.matchAll(pattern)].map(match => match[group]);
}

const apiCalled = new Set(matchAll(rendererSource, /window\.api\.([A-Za-z0-9_]+)\s*\(/g));

// Entries may wrap across lines, so each one is read from its own header up to
// the next header rather than with a single line-anchored pattern. A request
// maps to an invoke channel; a subscription maps to a push channel.
const { apiInvokes, apiSubscribes } = (() => {
  const headers = [...preloadSource.matchAll(/^ {2}([A-Za-z0-9_]+):/gm)];
  const invokes = new Map();
  const subscribes = new Map();
  headers.forEach((header, index) => {
    const start = header.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : preloadSource.length;
    const body = preloadSource.slice(start, end);
    const invoke = body.match(/ipcRenderer\.invoke\('([^']+)'/);
    const push = body.match(/subscribe\('([^']+)'\)/);
    if (invoke) invokes.set(header[1], invoke[1]);
    else if (push) subscribes.set(header[1], push[1]);
  });
  return { apiInvokes: invokes, apiSubscribes: subscribes };
})();
const apiExposed = new Set([...apiInvokes.keys(), ...apiSubscribes.keys()]);
const channelsHandled = new Set(matchAll(mainSource, /ipcMain\.handle\('([^']+)'/g));
const channelsPushed = new Set(matchAll(mainSource, /\bsend\('([^']+)'/g));

test('the preload bridge exposes something at all', () => {
  assert.ok(apiInvokes.size >= 12, `only ${apiInvokes.size} request methods parsed from preload.js`);
  assert.ok(apiSubscribes.size >= 1, 'no push subscriptions parsed from preload.js');
  assert.ok(apiCalled.size >= 12, `only ${apiCalled.size} api calls parsed from renderer.js`);
});

test('every api method the page calls is exposed by preload', () => {
  const missing = [...apiCalled].filter(name => !apiExposed.has(name));
  assert.deepStrictEqual(missing, [], `renderer calls window.api.${missing.join(', ')} which preload does not expose`);
});

test('every exposed request reaches a handler in main', () => {
  const orphans = [...apiInvokes].filter(([, channel]) => !channelsHandled.has(channel));
  assert.deepStrictEqual(orphans.map(([name, channel]) => `${name} -> ${channel}`), [],
    'preload maps these to channels nothing handles');
});

test('every subscription has a sender in main, and every push has a listener', () => {
  const orphans = [...apiSubscribes].filter(([, channel]) => !channelsPushed.has(channel));
  assert.deepStrictEqual(orphans.map(([name, channel]) => `${name} <- ${channel}`), [],
    'preload listens on channels main never sends');
  const unheard = [...channelsPushed].filter(channel => ![...apiSubscribes.values()].includes(channel));
  assert.deepStrictEqual(unheard, [], 'main pushes on channels nothing listens to');
});

test('no handler in main is unreachable from the page', () => {
  const reachable = new Set(apiInvokes.values());
  const dead = [...channelsHandled].filter(channel => !reachable.has(channel));
  assert.deepStrictEqual(dead, [], 'main handles these channels but nothing can call them');
});

test('no exposed api method goes unused by the page', () => {
  const unused = [...apiExposed].filter(name => !apiCalled.has(name));
  assert.deepStrictEqual(unused, [], `preload exposes ${unused.join(', ')} but nothing calls them`);
});

test('every element id the page looks up actually exists in the HTML', () => {
  const ids = new Set(matchAll(htmlSource, /\sid="([^"]+)"/g));
  const looked = new Set(matchAll(rendererSource, /\$\('#([A-Za-z0-9_-]+)[' ]/g));
  const missing = [...looked].filter(id => !ids.has(id));
  assert.deepStrictEqual(missing, [], `renderer looks up #${missing.join(', #')} which the HTML does not contain`);
});

test('every id in the HTML is unique', () => {
  const ids = matchAll(htmlSource, /\sid="([^"]+)"/g);
  const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepStrictEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('every tab has a view to show, and the game sheet is an overlay with no tab', () => {
  const tabs = new Set(matchAll(htmlSource, /data-view="([^"]+)"/g));
  const views = new Set(matchAll(htmlSource, /class="view[^"]*" id="view-([^"]+)"/g));
  const missing = [...tabs].filter(view => !views.has(view));
  assert.deepStrictEqual(missing, [], `tabs point at views that do not exist: ${missing.join(', ')}`);
  assert.ok(!tabs.has('game'), 'the game sheet must open from a card, never a tab');
  assert.match(htmlSource, /class="overlay" id="view-game" hidden/);
  for (const view of ['home', 'library', 'runtimes', 'log', 'settings', 'about']) assert.ok(tabs.has(view), `no tab for ${view}`);
});

test('the page never gets node or raw ipc', () => {
  assert.match(mainSource, /contextIsolation:\s*true/);
  assert.match(mainSource, /nodeIntegration:\s*false/);
  assert.doesNotMatch(preloadSource, /exposeInMainWorld\('[^']*',\s*\{?\s*ipcRenderer/,
    'ipcRenderer itself must never be exposed to the page');
  assert.doesNotMatch(preloadSource, /:\s*ipcRenderer\s*[,}\n]/, 'ipcRenderer must not leak through the api object');
  assert.match(htmlSource, /Content-Security-Policy/);
  assert.match(htmlSource, /default-src 'none'/);
});

test('external links are opened by name from a table, never by URL from the page', () => {
  assert.doesNotMatch(rendererSource, /https?:\/\//, 'the renderer must not carry URLs');
  assert.match(mainSource, /const LINKS = \{/);
  const names = new Set(matchAll(mainSource, /^ {2}(\w+): 'https:\/\//gm));
  const used = new Set(matchAll(htmlSource, /data-link="([^"]+)"/g));
  const unknown = [...used].filter(name => !names.has(name));
  assert.deepStrictEqual(unknown, [], `the page links to names main does not know: ${unknown.join(', ')}`);
});

test('the renderer never builds DOM from a string', () => {
  // innerHTML with interpolated values is how a game name with a quote in it
  // turns into markup. Everything here goes through textContent instead.
  assert.doesNotMatch(rendererSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(rendererSource, /insertAdjacentHTML/);
  assert.doesNotMatch(rendererSource, /outerHTML/);
});

test('dropped files reach main only through the preload path lookup', () => {
  assert.match(preloadSource, /webUtils\.getPathForFile\(file\)/);
  assert.doesNotMatch(rendererSource, /\.path\b/, 'the page must not read File.path');
});

test('anti-cheat consent is never stored', () => {
  assert.doesNotMatch(rendererSource, /localStorage|sessionStorage/);
  assert.doesNotMatch(mainSource, /acknowledgedAntiCheat[^\n]*profiles\.write/);
  assert.match(rendererSource, /state\.acknowledged = false/);
});

test('renderer.js and the core parse as valid JavaScript', () => {
  const vm = require('node:vm');
  for (const file of ['ui/renderer.js', 'preload.js', 'main.js']) {
    assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), `${file} does not parse`);
  }
});

test('the stylesheet defines every class the renderer applies', () => {
  const applied = new Set();
  // Plain literals: element('div', 'a b c')
  for (const literal of matchAll(rendererSource, /element\('[a-z]+',\s*'([^']+)'/g)) {
    for (const name of literal.split(/\s+/)) applied.add(name);
  }
  // Template literals: element('div', `a ${x} b`) - the static words are checked.
  for (const literal of matchAll(rendererSource, /element\('[a-z]+',\s*`([^`]+)`/g)) {
    for (const name of literal.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) applied.add(name);
  }
  for (const literal of matchAll(rendererSource, /classList\.(?:add|toggle)\('([^']+)'/g)) applied.add(literal);
  const missing = [...applied].filter(name => name && !cssSource.includes(`.${name}`));
  assert.deepStrictEqual(missing, [], `these classes are applied but never styled: ${missing.join(', ')}`);
});

test('both themes define the same tokens', () => {
  const block = theme => (cssSource.match(new RegExp(`:root\\[data-theme="${theme}"\\] \\{([^}]*)\\}`)) || [])[1] || '';
  const tokens = theme => new Set(matchAll(block(theme), /(--[a-z0-9-]+):/g));
  const dark = tokens('dark');
  const light = tokens('light');
  assert.ok(dark.size >= 15, `only ${dark.size} dark tokens`);
  assert.deepStrictEqual([...dark].filter(t => !light.has(t)), [], 'dark defines tokens light lacks');
  assert.deepStrictEqual([...light].filter(t => !dark.has(t)), [], 'light defines tokens dark lacks');
});

test('the window is frameless and the toolbar is the only drag region besides the brand', () => {
  assert.match(mainSource, /frame:\s*false/);
  const drag = matchAll(cssSource, /^([^{\n]+)\{[^}]*-webkit-app-region:\s*drag/gm).map(s => s.trim());
  assert.deepStrictEqual(drag.sort(), ['.brand', '.toolbar'].sort());
  assert.match(cssSource, /\.overlay[^{]*\{[^}]*-webkit-app-region:\s*no-drag/);
});
