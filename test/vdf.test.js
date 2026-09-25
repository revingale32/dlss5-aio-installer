// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parse, get } = require('../core/vdf');

const fixtures = path.join(__dirname, 'fixtures');

test('parses a real libraryfolders.vdf, keeping Windows paths intact', () => {
  const text = fs.readFileSync(path.join(fixtures, 'libraryfolders.vdf'), 'utf8');
  const root = parse(text);
  const zero = get(root, 'libraryfolders', '0');
  assert.ok(zero, 'library 0 is present');
  // The file stores C:\\Program Files (x86)\\Steam - doubled backslashes are
  // escapes, not literal characters.
  assert.strictEqual(get(zero, 'path'), 'C:\\Program Files (x86)\\Steam');
  assert.strictEqual(get(root, 'libraryfolders', '1', 'path'), 'D:\\SteamLibrary');
  const apps = get(zero, 'apps');
  assert.ok(apps['311210'], 'Black Ops III appid is listed');
  assert.strictEqual(Object.keys(apps).length, 2);
});

test('parses a real appmanifest', () => {
  const text = fs.readFileSync(path.join(fixtures, 'appmanifest_311210.acf'), 'utf8');
  const state = get(parse(text), 'AppState');
  assert.strictEqual(get(state, 'name'), 'Call of Duty: Black Ops III');
  assert.strictEqual(get(state, 'installdir'), 'Call of Duty Black Ops III');
  assert.strictEqual(get(state, 'appid'), '311210');
});

test('handles escapes, comments, bare keys and conditionals', () => {
  const text = `
    "root"   // trailing comment
    {
      "quoted"  "a\\"b"
      "path"    "C:\\\\Games\\\\X"
      bare      value
      "conditional" "yes" [$WIN32]
      "nested"
      {
        "deep" "1"
      }
    }`;
  const root = get(parse(text), 'root');
  assert.strictEqual(get(root, 'quoted'), 'a"b');
  assert.strictEqual(get(root, 'path'), 'C:\\Games\\X');
  assert.strictEqual(get(root, 'bare'), 'value');
  assert.strictEqual(get(root, 'conditional'), 'yes');
  assert.strictEqual(get(root, 'nested', 'deep'), '1');
});

test('duplicate keys keep the first, and lookup is case-insensitive', () => {
  const root = get(parse('"r" { "k" "first" "k" "second" }'), 'r');
  assert.strictEqual(get(root, 'k'), 'first');
  assert.strictEqual(get(root, 'K'), 'first');
});

test('malformed input does not throw', () => {
  assert.doesNotThrow(() => parse('"unterminated'));
  assert.doesNotThrow(() => parse('{{{{'));
  assert.doesNotThrow(() => parse(''));
});
