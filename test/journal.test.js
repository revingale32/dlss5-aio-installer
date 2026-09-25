// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const journal = require('../core/journal');
const ini = require('../core/ini');

function tempGame() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-'));
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'ORIGINAL DXGI');
  fs.writeFileSync(path.join(dir, 'game.exe'), 'GAME');
  return dir;
}

test('a failed install leaves every byte as it was', () => {
  const dir = tempGame();
  try {
    const txn = new journal.Transaction(dir).begin();
    txn.writeFile(path.join(dir, 'dxgi.dll'), Buffer.from('RESHADE'));
    txn.writeFile(path.join(dir, 'standalone-dlssnr.addon64'), Buffer.from('ADDON'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dxgi.dll'), 'utf8'), 'RESHADE');

    const failures = txn.rollback();
    assert.deepStrictEqual(failures, []);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dxgi.dll'), 'utf8'), 'ORIGINAL DXGI');
    assert.strictEqual(fs.existsSync(path.join(dir, 'standalone-dlssnr.addon64')), false,
      'a file we created is removed, not left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writing the same file twice still rolls back to the true original', () => {
  const dir = tempGame();
  try {
    const txn = new journal.Transaction(dir).begin();
    txn.writeFile(path.join(dir, 'dxgi.dll'), Buffer.from('FIRST'));
    txn.writeFile(path.join(dir, 'dxgi.dll'), Buffer.from('SECOND'));
    txn.rollback();
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dxgi.dll'), 'utf8'), 'ORIGINAL DXGI');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an interrupted install is detected and recovered on the next run', () => {
  const dir = tempGame();
  try {
    const txn = new journal.Transaction(dir).begin();
    txn.writeFile(path.join(dir, 'dxgi.dll'), Buffer.from('HALF INSTALLED'));
    // Process dies here: commit() never runs and the journal stays on disk.

    assert.strictEqual(journal.pendingTransactions(dir).length, 1);
    const recovered = journal.recover(dir);
    assert.strictEqual(recovered.length, 1);
    assert.deepStrictEqual(recovered[0].failures, []);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dxgi.dll'), 'utf8'), 'ORIGINAL DXGI');
    assert.strictEqual(journal.pendingTransactions(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a committed install is not rolled back by recovery', () => {
  const dir = tempGame();
  try {
    const txn = new journal.Transaction(dir).begin();
    txn.writeFile(path.join(dir, 'dxgi.dll'), Buffer.from('RESHADE'));
    txn.commit();
    txn.finish();
    assert.deepStrictEqual(journal.recover(dir), []);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dxgi.dll'), 'utf8'), 'RESHADE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupted backup is reported, never silently skipped', () => {
  const dir = tempGame();
  try {
    const txn = new journal.Transaction(dir).begin();
    txn.writeFile(path.join(dir, 'dxgi.dll'), Buffer.from('RESHADE'));
    fs.rmSync(txn.records[0].backup, { force: true });      // the disk ate it
    const failures = txn.rollback();
    assert.strictEqual(failures.length, 1);
    assert.match(failures[0].error, /missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- ini

test('CRLF survives an edit, and unrelated sections are untouched', () => {
  const original = ['[GENERAL]', 'PresetPath=.\\x.ini', '', '[Standalone.DLSSNR]', 'Passes=1', 'Model=3', ''].join('\r\n');
  const next = ini.upsertSection(original, 'Standalone.DLSSNR', { Passes: '2', PresentQueueLimit: '1' });
  assert.ok(next.includes('\r\n'), 'still CRLF');
  assert.ok(!/[^\r]\n/.test(next), 'no bare LF was introduced');
  assert.ok(next.includes('Passes=2'));
  assert.ok(next.includes('Model=3'), 'an untouched key keeps its value');
  assert.ok(next.includes('PresentQueueLimit=1'), 'a new key is added inside the section');
  assert.ok(next.includes('PresetPath=.\\x.ini'), 'another section is left alone');
});

test('a missing section is appended rather than replacing the file', () => {
  const original = '[GENERAL]\r\nPresetPath=.\\x.ini\r\n';
  const next = ini.upsertSection(original, 'Standalone.DLSSNR', { Passes: '2' });
  assert.ok(next.startsWith('[GENERAL]'));
  assert.ok(next.includes('[Standalone.DLSSNR]'));
  assert.ok(next.includes('Passes=2'));
});

test('an empty file gets a clean section', () => {
  const next = ini.upsertSection('', 'Standalone.DLSSNR', { Enabled: '1' });
  assert.strictEqual(next.trim(), '[Standalone.DLSSNR]\nEnabled=1'.trim().replace(/\n/g, '\n'));
});

test('enableAddon removes only our entry from DisabledAddons', () => {
  const original = '[ADDON]\r\nDisabledAddons=Other@other.addon64,DLSS 5 Neural Rendering@standalone-dlssnr.addon64\r\n';
  const next = ini.enableAddon(original, 'standalone-dlssnr');
  assert.ok(!next.includes('standalone-dlssnr'));
  assert.ok(next.includes('Other@other.addon64'), 'someone else\'s disabled add-on stays disabled');
});
