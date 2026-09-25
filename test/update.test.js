// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const updates = require('../core/update');

test('updates: nothing is checked on start until the user has said yes', () => {
  assert.strictEqual(updates.checkOnStart({ checkUpdates: null }), false, 'not asked yet = no check');
  assert.strictEqual(updates.checkOnStart({ checkUpdates: false }), false);
  assert.strictEqual(updates.checkOnStart({ checkUpdates: true }), true);
  assert.strictEqual(updates.checkOnStart({ checkUpdates: 'yes' }), false, 'only a real true counts');
  assert.strictEqual(updates.checkOnStart(null), false);
});

test('updates: the first question names the official page and says nothing else is sent', () => {
  const bar = updates.bar({ enabled: true, consent: null, current: '0.4.0', state: { state: 'idle' } });
  assert.deepStrictEqual(bar.actions, ['allow', 'deny']);
  assert.match(bar.message, /github\.com\/revingale32\/dlss5-aio-installer/);
  assert.match(bar.message, /Nothing else is sent/);
  assert.deepStrictEqual(updates.bar({ enabled: true, consent: null, dismissed: true }).actions, [], 'Later hides it for now');
  assert.deepStrictEqual(updates.bar({ enabled: false, consent: null }), { message: '', actions: [] }, 'a copy run from source never asks');
});

test('updates: each step of an update offers the right buttons', () => {
  const base = { enabled: true, consent: true, current: '0.4.0' };
  assert.deepStrictEqual(updates.bar({ ...base, state: { state: 'none' } }).actions, [], 'up to date = no bar');
  assert.deepStrictEqual(updates.bar({ ...base, state: { state: 'checking' } }).actions, []);
  const available = updates.bar({ ...base, state: { state: 'available', version: '0.4.1' } });
  assert.deepStrictEqual(available.actions, ['download', 'notes', 'later']);
  assert.match(available.message, /0\.4\.1 is available - you have 0\.4\.0/);
  assert.match(updates.bar({ ...base, state: { state: 'downloading', version: '0.4.1', percent: 41.6 } }).message, /42%/);
  assert.deepStrictEqual(updates.bar({ ...base, state: { state: 'downloaded', version: '0.4.1' } }).actions, ['restart', 'later']);
  assert.deepStrictEqual(updates.bar({ ...base, state: { state: 'error', during: 'download', message: 'x' } }).actions, ['download', 'later'],
    'a failed download can be retried');
  assert.deepStrictEqual(updates.bar({ ...base, state: { state: 'error', during: 'check', message: 'x' } }).actions, [],
    'a failed background check stays quiet (the About page says it)');
  assert.deepStrictEqual(updates.bar({ ...base, consent: false, state: { state: 'available', version: '0.4.1' } }).actions,
    ['download', 'notes', 'later'], 'a manual check with automatic checks off still offers the update');
});

test('updates: errors come out as one plain line', () => {
  assert.match(updates.errorText(new Error('net::ERR_INTERNET_DISCONNECTED')), /could not be reached/);
  assert.match(updates.errorText(new Error('getaddrinfo ENOTFOUND github.com')), /could not be reached/);
  assert.match(updates.errorText(new Error('Cannot find latest.yml in the latest release artifacts (https://github.com/x/y/releases/download/v1/latest.yml): HttpError: 404')),
    /No update information/);
  const long = updates.errorText(new Error(`boom ${'x'.repeat(400)}\n    at somewhere (file.js:1:1)`));
  assert.ok(long.length <= 180 && !/at somewhere/.test(long), 'no stack, capped');
  assert.strictEqual(updates.errorText(null), 'unknown error');
});

test('updates: the About line says where things stand', () => {
  const base = { enabled: true, current: '0.4.0' };
  assert.match(updates.status({ ...base, consent: null, state: { state: 'idle' } }), /Not checked yet/);
  assert.match(updates.status({ ...base, consent: true, state: { state: 'idle' } }), /when the app starts/);
  assert.match(updates.status({ ...base, consent: false, state: { state: 'idle' } }), /still works/);
  assert.match(updates.status({ ...base, state: { state: 'none' } }), /newest version \(0\.4\.0\)/);
  assert.match(updates.status({ enabled: false }), /installed app/);
});

test('updates: the build publishes to the official repo, as real releases, and never uploads by itself', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.build.publish, [{ provider: 'github', owner: 'revingale32', repo: 'dlss5-aio-installer', releaseType: 'release' }]);
  assert.match(pkg.scripts.build, /--publish never/);
  assert.doesNotMatch(pkg.build.nsis.artifactName, / /, 'GitHub renames files with spaces, which would break the updater\'s download link');
  assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'], 'electron-updater ships with the app');
  assert.ok(pkg.build.files.includes('node_modules/**/*'), 'its modules are packaged');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /autoDownload = false/, 'nothing downloads until the user presses Update');
  assert.match(main, /autoInstallOnAppQuit = false/, 'nothing installs behind the user\'s back');
  assert.match(main, /updates\.checkOnStart\(/, 'the start-up check goes through the consent rule');
});
