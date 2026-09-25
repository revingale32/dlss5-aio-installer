// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const pe = require('../core/pe');

const os = require('os');

const fixtures = path.join(__dirname, 'fixtures');
const ourAddon = path.join(fixtures, 'standalone-dlssnr.addon64');
// Files the tests make up go to a temp folder, never into the repo.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-pe-'));

test('reads bitness and imports from a real 64-bit PE', { skip: !fs.existsSync(ourAddon) }, () => {
  const info = pe.inspect(ourAddon);
  assert.strictEqual(info.bitness, 64);
  assert.ok(info.imports.length > 0, 'import table was found');
  assert.ok(info.imports.includes('d3d12.dll'), 'imports d3d12');
  assert.strictEqual(info.api, 'd3d12');
});

test('a non-PE file is reported as unknown, not thrown over', () => {
  const junk = path.join(scratch, 'not-a-pe.bin');
  fs.writeFileSync(junk, Buffer.from('this is not an executable'));
  try {
    const info = pe.inspect(junk);
    assert.strictEqual(info.bitness, 0);
    assert.strictEqual(info.api, 'unknown');
    assert.deepStrictEqual(info.imports, []);
  } finally {
    fs.unlinkSync(junk);
  }
});

test('a missing file is reported as unknown, not thrown over', () => {
  const info = pe.inspect(path.join(fixtures, 'does-not-exist.exe'));
  assert.strictEqual(info.bitness, 0);
  assert.strictEqual(info.api, 'unknown');
});

test('API detection prefers the most specific evidence', () => {
  // A DX11 game that also carries a legacy d3d9 import must not read as DX9,
  // and a DX12 game that imports dxgi must not read as "dxgi".
  assert.strictEqual(pe.detectApi(['d3d11.dll', 'd3d9.dll', 'dxgi.dll']), 'd3d11');
  assert.strictEqual(pe.detectApi(['dxgi.dll', 'd3d12.dll']), 'd3d12');
  assert.strictEqual(pe.detectApi(['dxgi.dll']), 'dxgi');
  assert.strictEqual(pe.detectApi(['kernel32.dll', 'user32.dll']), 'unknown');
  assert.strictEqual(pe.detectApi([]), 'unknown');
});

// Guarded: these are the user's own game files, never committed to the repo.
// When they happen to be staged locally the real-world checks run too.
const avp = '/mnt/user-data/uploads/common/Aliens vs Predator';
test('real game executables classify correctly', { skip: !fs.existsSync(avp) }, () => {
  const dx11 = pe.inspect(path.join(avp, 'AvP_DX11.exe'));
  assert.strictEqual(dx11.bitness, 32);
  assert.strictEqual(dx11.api, 'd3d11');

  const dx9 = pe.inspect(path.join(avp, 'AvP.exe'));
  assert.strictEqual(dx9.api, 'd3d9');

  assert.strictEqual(dx11.apiSource, 'import');
  assert.strictEqual(dx9.apiSource, 'import');

  // The launcher is the trap every installer hits: same folder, looks like the
  // game. It carries the string "d3d11.dll" because it is the DX9/DX11 chooser,
  // so it reads as a *dynamic* hint - weaker evidence than an import, and the
  // ranker treats it that way.
  const launcher = pe.inspect(path.join(avp, 'AvP_Launcher.exe'));
  assert.strictEqual(launcher.apiSource, 'dynamic');
  assert.deepStrictEqual(launcher.imports.filter(d => /d3d|dxgi|vulkan/.test(d)), [],
    'it imports no graphics runtime of its own');

  const scan = require('../core/scan');
  const ranked = scan.rankCandidates([dx11, dx9, launcher].map(info => ({
    name: path.basename(info.file), file: info.file, size: fs.statSync(info.file).size,
    api: info.api, apiSource: info.apiSource, bitness: info.bitness, depth: 0,
  })));
  assert.strictEqual(scan.pickBest(ranked).name, 'AvP_DX11.exe');
  assert.strictEqual(ranked[ranked.length - 1].name, 'AvP_Launcher.exe');
});

test('a runtime loaded with LoadLibrary is still detected', () => {
  // Unreal and Unity import no graphics DLL; the name only appears as a string
  // because that is what goes to LoadLibrary. Reading imports alone reports
  // "unknown" and the game gets labelled a launcher.
  const file = path.join(scratch, 'dynamic-loader.bin');
  const header = fs.readFileSync(ourAddon).subarray(0, 4096);   // a real PE header
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from('....d3d12.dll....D3D12RHI....', 'latin1')]));
  try {
    assert.ok(pe.findDynamicNames(file).includes('d3d12.dll'));
  } finally {
    fs.unlinkSync(file);
  }
});

test('names are found even when they straddle a chunk boundary', () => {
  const file = path.join(scratch, 'boundary.bin');
  // Put the name right at the edge of the first chunk.
  const chunk = 1024;
  const pad = Buffer.alloc(chunk - 4, 0x41);
  fs.writeFileSync(file, Buffer.concat([pad, Buffer.from('d3d12.dll', 'latin1'), Buffer.alloc(64)]));
  try {
    assert.ok(pe.findDynamicNames(file, { chunkSize: chunk }).includes('d3d12.dll'));
  } finally {
    fs.unlinkSync(file);
  }
});
