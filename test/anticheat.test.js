// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const anticheat = require('../core/anticheat');

function tempDir(build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));
  build(dir);
  return dir;
}

test('a clean folder reports nothing and produces no warning', () => {
  const dir = tempDir(d => fs.writeFileSync(path.join(d, 'game.exe'), 'x'));
  try {
    const found = anticheat.detect(dir);
    assert.strictEqual(found.present, false);
    assert.strictEqual(anticheat.warning(found), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('EasyAntiCheat is found by folder and by bootstrapper', () => {
  const byDir = tempDir(d => fs.mkdirSync(path.join(d, 'EasyAntiCheat_EOS')));
  const byExe = tempDir(d => fs.writeFileSync(path.join(d, 'start_protected_game.exe'), 'x'));
  try {
    assert.ok(anticheat.detect(byDir).systems.includes('EasyAntiCheat'));
    assert.ok(anticheat.detect(byExe).systems.includes('EasyAntiCheat'));
  } finally {
    fs.rmSync(byDir, { recursive: true, force: true });
    fs.rmSync(byExe, { recursive: true, force: true });
  }
});

test('BattlEye is found by the _BE executable, and gets the launch-option note', () => {
  const dir = tempDir(d => fs.writeFileSync(path.join(d, 'GTA5_Enhanced_BE.exe'), 'x'));
  try {
    const found = anticheat.detect(dir);
    assert.deepStrictEqual(found.systems, ['BattlEye']);
    const text = anticheat.warning(found);
    assert.match(text, /never bypasses anti-cheat/);
    assert.match(text, /-nobattleye/);
    assert.match(text, /game's own switch, not a bypass/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the warning never promises a way past anything', () => {
  const dir = tempDir(d => fs.mkdirSync(path.join(d, 'EasyAntiCheat')));
  try {
    const text = anticheat.warning(anticheat.detect(dir));
    assert.doesNotMatch(text, /bypass(ing)? (it|the anti)/i);
    assert.match(text, /no anti-cheat in it/);
    assert.match(text, /risk sits with you/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('detection is bounded and does not throw on an unreadable folder', () => {
  assert.doesNotThrow(() => anticheat.detect('/does/not/exist'));
  assert.strictEqual(anticheat.detect('/does/not/exist').present, false);
});
