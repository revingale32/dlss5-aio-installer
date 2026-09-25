// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// The fake neural runtime these tests scaffold has no known-good hash; the gate
// that refuses unknown copies is tested on its own in hardening.test.js.
process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const profiles = require('../core/profiles');
const install = require('../core/install');
const runtimes = require('../core/runtimes');

function appRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'state-')); }

test('a per-game profile round-trips and is keyed by folder', () => {
  const root = appRoot();
  try {
    profiles.writeProfile(root, 'C:\\Games\\One', { Passes: '3' });
    profiles.writeProfile(root, 'C:\\Games\\Two', { Passes: '1' });
    assert.deepStrictEqual(profiles.readProfile(root, 'C:\\Games\\One'), { Passes: '3' });
    assert.deepStrictEqual(profiles.readProfile(root, 'C:\\Games\\Two'), { Passes: '1' });
    // Windows paths are case-insensitive; the same folder must not get two profiles.
    assert.deepStrictEqual(profiles.readProfile(root, 'c:\\games\\one'), { Passes: '3' });
    assert.deepStrictEqual(profiles.readProfile(root, 'C:\\Games\\Three'), {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual games are remembered, deduplicated and forgettable', () => {
  const root = appRoot();
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'g-'));
  try {
    profiles.addManualGame(root, { id: 'manual:1', store: 'Manual', name: 'G', dir: game });
    profiles.addManualGame(root, { id: 'manual:1', store: 'Manual', name: 'G', dir: game.toUpperCase() });
    assert.strictEqual(profiles.readManualGames(root).length, 1, 'the same folder is not added twice');
    profiles.removeManualGame(root, game);
    assert.strictEqual(profiles.readManualGames(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(game, { recursive: true, force: true });
  }
});

test('a manual game whose folder is gone disappears from the list', () => {
  const root = appRoot();
  try {
    profiles.addManualGame(root, { id: 'manual:x', store: 'Manual', name: 'Gone', dir: path.join(root, 'nope') });
    assert.deepStrictEqual(profiles.readManualGames(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a runtime folder the user points at is actually used by the planner', () => {
  const root = appRoot();
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'game-'));
  try {
    fs.mkdirSync(path.join(root, 'payload'), { recursive: true });
    fs.writeFileSync(path.join(root, 'payload', 'ReShade64.dll'), 'R');
    fs.writeFileSync(path.join(root, 'payload', 'standalone-dlssnr.addon64'), 'A');
    fs.writeFileSync(path.join(game, 'game.exe'), 'G');
    // The runtime lives somewhere the default search would never look.
    fs.writeFileSync(path.join(stash, 'nvngx_dlssnr.dll'), Buffer.alloc(41 * 1024 * 1024, 1));

    const target = { dir: game, exe: { file: path.join(game, 'game.exe'), name: 'game.exe', bitness: 64, api: 'd3d12', renders: true } };
    process.env.LOCALAPPDATA = path.join(root, 'localappdata');
    fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
    const without = install.plan(target, { appRoot: root });
    assert.strictEqual(without.installable, false, 'not findable by default');

    profiles.addRuntimeDir(root, stash);
    const withDir = install.plan(target, { appRoot: root, extraRuntimeDirs: profiles.readRuntimeDirs(root) });
    assert.strictEqual(withDir.installable, true, withDir.problems.join(' '));
    assert.ok(withDir.files.some(file => file.from === path.join(stash, 'nvngx_dlssnr.dll')));
  } finally {
    for (const dir of [root, stash, game]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stub runtime is rejected with its real size named', () => {
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  try {
    fs.writeFileSync(path.join(stash, 'nvngx_dlssnr.dll'), Buffer.alloc(2 * 1024 * 1024));
    const found = runtimes.locate({ extraDirs: [stash] });
    const state = runtimes.describe(found);
    assert.strictEqual(state.ok, false);
    assert.match(state.message, /2\.0 MB/);
    assert.match(state.message, /158 MB/);
  } finally { fs.rmSync(stash, { recursive: true, force: true }); }
});

test('a read-only app folder does not crash the app', () => {
  // A portable copy on a read-only stick still has to open.
  assert.doesNotThrow(() => profiles.writeProfile('/proc/nonexistent-root', 'x', { a: '1' }));
  assert.deepStrictEqual(profiles.readProfile('/proc/nonexistent-root', 'x'), {});
});
