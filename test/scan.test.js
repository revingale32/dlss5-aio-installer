// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scan = require('../core/scan');

// The cases below are the real folder layouts of the games this build runs on.
// Sizes and APIs are what the PE reader actually reported for those files.

function pick(entries) {
  return scan.pickBest(scan.rankCandidates(entries)).name;
}

test('GTA V Enhanced: the game wins over the launcher and the BattlEye shim', () => {
  assert.strictEqual(pick([
    { name: 'GTA5_Enhanced.exe', size: 56064632, api: 'd3d12', bitness: 64, depth: 0 },
    { name: 'PlayGTAV.exe', size: 572536, api: 'unknown', bitness: 64, depth: 0 },
    { name: 'GTA5_Enhanced_BE.exe', size: 1473144, api: 'unknown', bitness: 64, depth: 0 },
  ]), 'GTA5_Enhanced.exe');
});

test('Black Ops III: the game wins over the crash uploader', () => {
  assert.strictEqual(pick([
    { name: 'BlackOps3.exe', size: 106059256, api: 'd3d11', bitness: 64, depth: 0 },
    { name: 'CrashUploader.exe', size: 695808, api: 'unknown', bitness: 64, depth: 0 },
  ]), 'BlackOps3.exe');
});

test('Aliens vs Predator: the DX11 build wins over DX9 and the launcher', () => {
  const ranked = scan.rankCandidates([
    { name: 'AvP_DX11.exe', size: 7290008, api: 'd3d11', bitness: 32, depth: 0 },
    { name: 'AvP.exe', size: 7625880, api: 'd3d9', bitness: 32, depth: 0 },
    { name: 'AvP_Launcher.exe', size: 394568, api: 'unknown', bitness: 32, depth: 0 },
  ]);
  assert.strictEqual(scan.pickBest(ranked).name, 'AvP_DX11.exe');
  // The DX9 build is still offered - it is a legitimate choice, just not the default.
  assert.ok(ranked.find(e => e.name === 'AvP.exe').renders);
  assert.strictEqual(ranked[ranked.length - 1].name, 'AvP_Launcher.exe');
});

test('a bigger launcher never beats a smaller renderer', () => {
  assert.strictEqual(pick([
    { name: 'BigLauncher.exe', size: 400 * 1024 * 1024, api: 'unknown', bitness: 64, depth: 0 },
    { name: 'game.exe', size: 4 * 1024 * 1024, api: 'd3d12', bitness: 64, depth: 0 },
  ]), 'game.exe');
});

test('an EAC bootstrapper is demoted below the real executable', () => {
  assert.strictEqual(pick([
    { name: 'start_protected_game.exe', size: 900000, api: 'unknown', bitness: 64, depth: 0 },
    { name: 'DeadByDaylight-Win64-Shipping.exe', size: 90000000, api: 'd3d11', bitness: 64, depth: 2 },
  ]), 'DeadByDaylight-Win64-Shipping.exe');
});

test('a shallow renderer beats an equally valid deeper one', () => {
  const ranked = scan.rankCandidates([
    { name: 'game.exe', size: 20 * 1024 * 1024, api: 'd3d11', bitness: 64, depth: 0 },
    { name: 'game.exe', size: 20 * 1024 * 1024, api: 'd3d11', bitness: 64, depth: 3 },
  ]);
  assert.strictEqual(ranked[0].depth, 0);
});

test('when nothing renders, the least launcher-ish file is still offered', () => {
  const best = scan.pickBest(scan.rankCandidates([
    { name: 'Launcher.exe', size: 1000, api: 'unknown', bitness: 64, depth: 0 },
    { name: 'mystery.exe', size: 50 * 1024 * 1024, api: 'unknown', bitness: 64, depth: 0 },
  ]));
  assert.strictEqual(best.name, 'mystery.exe');
  assert.strictEqual(best.renders, false);   // the UI must be able to warn about this
});

test('an empty folder yields nothing rather than throwing', () => {
  assert.strictEqual(scan.pickBest(scan.rankCandidates([])), null);
});

test('findExecutables skips the folders that never hold a renderer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  try {
    fs.writeFileSync(path.join(root, 'game.exe'), 'x');
    for (const skip of ['redist', 'EasyAntiCheat', 'reshade-shaders']) {
      fs.mkdirSync(path.join(root, skip));
      fs.writeFileSync(path.join(root, skip, 'other.exe'), 'x');
    }
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'deep.exe'), 'x');
    const names = scan.findExecutables(root).map(e => e.name).sort();
    assert.deepStrictEqual(names, ['deep.exe', 'game.exe']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('steamGames reads a real library layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'));
  try {
    const steamapps = path.join(root, 'steamapps');
    fs.mkdirSync(path.join(steamapps, 'common', 'Call of Duty Black Ops III'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'appmanifest_311210.acf'),
      path.join(steamapps, 'appmanifest_311210.acf'));
    const games = scan.steamGames([steamapps]);
    assert.strictEqual(games.length, 1);
    assert.strictEqual(games[0].name, 'Call of Duty: Black Ops III');
    assert.strictEqual(games[0].appid, '311210');
    assert.strictEqual(games[0].store, 'Steam');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest whose files are gone is skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'));
  try {
    const steamapps = path.join(root, 'steamapps');
    fs.mkdirSync(steamapps, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'appmanifest_311210.acf'),
      path.join(steamapps, 'appmanifest_311210.acf'));
    assert.deepStrictEqual(scan.steamGames([steamapps]), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- regressions found by running it on a real library -------------------

test('Unreal: the shipping executable wins over the crash reporter that imports d3d11', () => {
  // Aliens: Fireteam Elite, exactly as it is on disk. The game imports no
  // graphics runtime at all (UE loads D3D12RHI itself); CrashReportClient is a
  // Slate app and does import d3d11. Reading imports alone picked the reporter.
  const ranked = scan.rankCandidates([
    { name: 'Endeavor.exe', file: 'C:/G/Endeavor.exe', size: 302592, api: 'unknown', bitness: 64, depth: 0 },
    { name: 'Endeavor-Win64-Shipping.exe', file: 'C:/G/Endeavor/Binaries/Win64/Endeavor-Win64-Shipping.exe',
      size: 89567232, api: 'd3d12', apiSource: 'dynamic', bitness: 64, depth: 3 },
    { name: 'CrashReportClient.exe', file: 'C:/G/Engine/Binaries/Win64/CrashReportClient.exe',
      size: 18225152, api: 'd3d11', apiSource: 'import', bitness: 64, depth: 3 },
  ]);
  const best = scan.pickBest(ranked);
  assert.strictEqual(best.name, 'Endeavor-Win64-Shipping.exe');
  assert.strictEqual(best.canonical, 'unreal');
  assert.strictEqual(ranked[ranked.length - 1].name, 'CrashReportClient.exe');
});

test('a demoted executable never wins just because it renders', () => {
  const best = scan.pickBest(scan.rankCandidates([
    { name: 'CrashReportClient.exe', file: 'C:/G/CrashReportClient.exe', size: 18e6, api: 'd3d11', bitness: 64, depth: 0 },
    { name: 'TheGame.exe', file: 'C:/G/TheGame.exe', size: 80e6, api: 'unknown', bitness: 64, depth: 0 },
  ]));
  assert.strictEqual(best.name, 'TheGame.exe');
});

test('Unity: the executable beside its _Data folder is canonical', () => {
  const best = scan.pickBest(scan.rankCandidates([
    { name: 'Game.exe', file: 'C:/G/Game.exe', size: 600000, api: 'unknown', bitness: 64, depth: 0, unityData: true },
    { name: 'UnityCrashHandler64.exe', file: 'C:/G/UnityCrashHandler64.exe', size: 1e6, api: 'unknown', bitness: 64, depth: 0 },
  ]));
  assert.strictEqual(best.name, 'Game.exe');
  assert.strictEqual(best.canonical, 'unity');
});

test('engineCanonical only fires on the real Unreal shape', () => {
  assert.strictEqual(scan.engineCanonical({ file: 'C:/G/P/Binaries/Win64/P-Win64-Shipping.exe', name: 'P-Win64-Shipping.exe' }), 'unreal');
  assert.strictEqual(scan.engineCanonical({ file: 'C:/G/Engine/Binaries/Win64/CrashReportClient.exe', name: 'CrashReportClient.exe' }), null);
  assert.strictEqual(scan.engineCanonical({ file: 'C:/G/game.exe', name: 'game.exe' }), null);
});
