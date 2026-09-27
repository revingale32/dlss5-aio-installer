// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// ReShade search paths and settings-file handling.
//
// 1. ReShade Setup 6.8 seeds `.\reshade-shaders\Shaders\**\**`; Windows rejects
//    the second `**` as a folder name (error 123) and no shader loads. Every
//    game the old kit touched had it (BO3, GTA V Enhanced, RE2 - found 2026-09-22).
// 2. ReShade.ini / OptiScaler.ini are rewritten by the game's overlay in normal
//    use. Verify must not call that a game update, and restore must still take
//    our section out.

process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const install = require('../core/install');
const ini = require('../core/ini');

const BROKEN = '[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\\**\r\nPresetPath=.\\ReShadePreset.ini\r\nTextureSearchPaths=.\\reshade-shaders\\Textures\\**\\**\r\n';

function scaffold({ existingIni = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-sp-'));
  const appRoot = path.join(root, 'app');
  const gameDir = path.join(root, 'game');
  for (const dir of ['payload/relay', 'payload/shaders', 'runtimes']) fs.mkdirSync(path.join(appRoot, dir), { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'payload', 'ReShade64.dll'), 'RESHADE PAYLOAD');
  fs.writeFileSync(path.join(appRoot, 'payload', 'ReShade32.dll'), 'RESHADE32 PAYLOAD');
  fs.writeFileSync(path.join(appRoot, 'payload', 'nvngx.dll'), 'BRIDGE PAYLOAD');
  fs.writeFileSync(path.join(appRoot, 'payload', 'standalone-dlssnr.addon64'), 'ADDON PAYLOAD Standalone DLSS-NR + SR 2.2.4-revin10b end');
  fs.writeFileSync(path.join(appRoot, 'payload', 'relay', 'neural-relay.exe'), 'RELAY');
  fs.writeFileSync(path.join(appRoot, 'payload', 'relay', 'neural-relay-launcher.addon32'), 'LAUNCHER');
  fs.writeFileSync(path.join(appRoot, 'payload', 'shaders', 'StandaloneBoundary.fx'), 'fx');
  fs.copyFileSync(path.join(__dirname, '..', 'payload', 'ReShade.ini.template'), path.join(appRoot, 'payload', 'ReShade.ini.template'));
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'runtimes', 'nvngx_dlssnr.dll'), Buffer.alloc(41 * 1024 * 1024, 1));
  fs.writeFileSync(path.join(gameDir, 'game.exe'), 'GAME');
  if (existingIni !== null) fs.writeFileSync(path.join(gameDir, 'ReShade.ini'), existingIni);
  const logFile = path.join(root, 'standalone-dlssnr.log');
  fs.writeFileSync(logFile, 'old');
  fs.utimesSync(logFile, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  return {
    appRoot, gameDir, logFile,
    target: { dir: gameDir, exe: { file: path.join(gameDir, 'game.exe'), name: 'game.exe', bitness: 64, api: 'd3d12', renders: true } },
    cleanup: () => {
      if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// What ReShade does to its config in normal use: rewrites it with a changed setting.
function reshadeRewrites(file) {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '[OVERLAY]\r\nShowFPS=1\r\n');
}

test('the doubled wildcard collapses to one, and other paths survive', () => {
  const required = '.\\reshade-shaders\\Shaders\\**';
  assert.strictEqual(ini.mergeSearchPath('.\\reshade-shaders\\Shaders\\**\\**', required), required);
  assert.strictEqual(ini.mergeSearchPath('.\\reshade-shaders\\Shaders\\**\\**\\**', required), required);
  assert.strictEqual(ini.mergeSearchPath('', required), required);
  assert.strictEqual(ini.mergeSearchPath('.\\reshade-shaders\\Shaders', required), required, 'recursive covers non-recursive');
  assert.strictEqual(ini.mergeSearchPath('D:/Packs/qUINT/**/**,.\\reshade-shaders\\Shaders\\**\\**', required),
    `${required},D:\\Packs\\qUINT\\**`, 'ours first, theirs repaired and kept');
  assert.strictEqual(ini.mergeSearchPath('C:\\Mine\\**,c:\\mine\\**', required), `${required},C:\\Mine\\**`, 'duplicates dropped');
});

test('repair keeps CRLF and every other key, and detection sees the broken form', () => {
  assert.strictEqual(ini.hasBrokenSearchPaths(BROKEN), true);
  const fixed = ini.repairSearchPaths(BROKEN, {
    EffectSearchPaths: '.\\reshade-shaders\\Shaders\\**', TextureSearchPaths: '.\\reshade-shaders\\Textures\\**',
  });
  assert.strictEqual(ini.hasBrokenSearchPaths(fixed), false);
  assert.ok(fixed.includes('EffectSearchPaths=.\\reshade-shaders\\Shaders\\**\r\n'));
  assert.ok(fixed.includes('TextureSearchPaths=.\\reshade-shaders\\Textures\\**\r\n'));
  assert.ok(fixed.includes('PresetPath=.\\ReShadePreset.ini\r\n'));
  assert.ok(!/[^\r]\n/.test(fixed), 'no bare LF introduced');
  assert.strictEqual(ini.hasBrokenSearchPaths('[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\r\n'), false);
});

test('the shipped ReShade.ini template has valid search paths', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'payload', 'ReShade.ini.template'), 'utf8');
  assert.strictEqual(ini.hasBrokenSearchPaths(template), false);
  const general = ini.readSectionFrom(template, 'GENERAL');
  assert.strictEqual(general.EffectSearchPaths, '.\\reshade-shaders\\Shaders\\**');
  assert.strictEqual(general.TextureSearchPaths, '.\\reshade-shaders\\Textures\\**');
});

test('installing over a Setup-6.8 config repairs it and says so', () => {
  const env = scaffold({ existingIni: BROKEN.replace('**\\**\r\nPresetPath', '**\\**,D:\\Packs\\**\r\nPresetPath') });
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.ok(planned.notes.some(n => /ReShade Setup 6\.8/.test(n)), planned.notes.join('\n'));
    install.apply(planned, { logFile: env.logFile });
    const general = ini.readSection(path.join(env.gameDir, 'ReShade.ini'), 'GENERAL');
    assert.strictEqual(general.EffectSearchPaths, '.\\reshade-shaders\\Shaders\\**,D:\\Packs\\**');
    assert.strictEqual(general.TextureSearchPaths, '.\\reshade-shaders\\Textures\\**');
    assert.strictEqual(general.PresetPath, '.\\ReShadePreset.ini');
  } finally { env.cleanup(); }
});

test('a fresh install writes valid search paths from the template', () => {
  const env = scaffold();
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.ok(!planned.notes.some(n => /ReShade Setup 6\.8/.test(n)));
    install.apply(planned, { logFile: env.logFile });
    const text = fs.readFileSync(path.join(env.gameDir, 'ReShade.ini'), 'utf8');
    assert.strictEqual(ini.hasBrokenSearchPaths(text), false);
    assert.strictEqual(ini.readSectionFrom(text, 'GENERAL').EffectSearchPaths, '.\\reshade-shaders\\Shaders\\**');
  } finally { env.cleanup(); }
});

test('ReShade rewriting its own config is not a game update', () => {
  const env = scaffold();
  try {
    const manifest = install.apply(install.plan(env.target, { appRoot: env.appRoot }), { logFile: env.logFile });
    const iniFile = path.join(env.gameDir, 'ReShade.ini');
    assert.ok(manifest.records.find(r => r.target === iniFile).config, 'the ini is flagged as settings');
    reshadeRewrites(iniFile);
    const check = install.verify(env.gameDir);
    assert.strictEqual(check.gameUpdated, false, check.summary);
    assert.deepStrictEqual(check.settings, [iniFile]);
    assert.ok(!check.changed.includes(iniFile));
    assert.strictEqual(install.status(env.gameDir).intact, true);
  } finally { env.cleanup(); }
});

test('restore removes a config we created even after ReShade rewrote it', () => {
  const env = scaffold();
  try {
    install.apply(install.plan(env.target, { appRoot: env.appRoot }), { logFile: env.logFile });
    const iniFile = path.join(env.gameDir, 'ReShade.ini');
    reshadeRewrites(iniFile);
    const result = install.restore(env.gameDir);
    assert.deepStrictEqual(result.skipped, []);
    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(fs.existsSync(iniFile), false, 'our section did not outlive the restore');
  } finally { env.cleanup(); }
});

test('restore puts the user\'s own config back even after ReShade rewrote ours', () => {
  const original = '[GENERAL]\r\nPresetPath=.\\mine.ini\r\n';
  const env = scaffold({ existingIni: original });
  try {
    install.apply(install.plan(env.target, { appRoot: env.appRoot }), { logFile: env.logFile });
    const iniFile = path.join(env.gameDir, 'ReShade.ini');
    reshadeRewrites(iniFile);
    const result = install.restore(env.gameDir);
    assert.deepStrictEqual(result.skipped, []);
    assert.strictEqual(fs.readFileSync(iniFile, 'utf8'), original, 'byte for byte');
  } finally { env.cleanup(); }
});

test('a manifest from before settings were flagged is still handled', () => {
  const env = scaffold();
  try {
    install.apply(install.plan(env.target, { appRoot: env.appRoot }), { logFile: env.logFile });
    const file = install.manifestFile(env.gameDir);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const record of manifest.records) delete record.config;   // 0.2.2 wrote no flag
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    const iniFile = path.join(env.gameDir, 'ReShade.ini');
    reshadeRewrites(iniFile);
    assert.strictEqual(install.verify(env.gameDir).gameUpdated, false);
    install.restore(env.gameDir);
    assert.strictEqual(fs.existsSync(iniFile), false);
  } finally { env.cleanup(); }
});

test('a real game-file change is still caught next to a rewritten config', () => {
  const env = scaffold();
  try {
    install.apply(install.plan(env.target, { appRoot: env.appRoot }), { logFile: env.logFile });
    reshadeRewrites(path.join(env.gameDir, 'ReShade.ini'));
    fs.writeFileSync(path.join(env.gameDir, 'dxgi.dll'), 'A GAME PATCH REPLACED THIS');
    const check = install.verify(env.gameDir);
    assert.strictEqual(check.gameUpdated, true);
    assert.deepStrictEqual(check.changed, [path.join(env.gameDir, 'dxgi.dll')]);
    const result = install.restore(env.gameDir);
    assert.deepStrictEqual(result.skipped, [path.join(env.gameDir, 'dxgi.dll')], 'the patched file is still left alone');
  } finally { env.cleanup(); }
});
