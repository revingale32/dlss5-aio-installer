// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// The 2026-09-19 hardening: the runtime hash gate, "what we installed is still
// there", first-original carry-over on reinstall, and a restore that refuses
// to write an old backup over a file the game has since updated.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const install = require('../core/install');
const runtimes = require('../core/runtimes');
const journal = require('../core/journal');
const authenticode = require('../core/authenticode');

function scaffold() {
  delete process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-hard-'));
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
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  const runtime = path.join(appRoot, 'runtimes', 'nvngx_dlssnr.dll');
  fs.writeFileSync(runtime, Buffer.alloc(41 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(gameDir, 'game.exe'), 'GAME');
  // A dxgi.dll the "game" shipped with: the original that restore must reach.
  fs.writeFileSync(path.join(gameDir, 'dxgi.dll'), 'THE GAMES OWN DXGI');
  const target = { dir: gameDir, exe: { file: path.join(gameDir, 'game.exe'), name: 'game.exe', bitness: 64, api: 'd3d12', renders: true } };
  const logFile = path.join(root, 'standalone-dlssnr.log');
  fs.writeFileSync(logFile, 'old');
  fs.utimesSync(logFile, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  return {
    root, appRoot, gameDir, target, logFile, runtime,
    cleanup: () => {
      if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Make the scaffold's fake runtime "known-good" for one test, without a real 158 MB file.
function withKnown(file, work) {
  const sha = runtimes.sha256(file);
  runtimes.KNOWN_GOOD.nr[sha] = { version: 'test', bytes: fs.statSync(file).size };
  try { return work(); } finally { delete runtimes.KNOWN_GOOD.nr[sha]; }
}

test('an unvalidated neural runtime is refused by default, allowed only by choice', () => {
  const env = scaffold();
  try {
    const blocked = install.plan(env.target, { appRoot: env.appRoot });
    assert.strictEqual(blocked.installable, false);
    assert.ok(blocked.problems.some(p => /not a validated copy/.test(p)), blocked.problems.join(' '));
    assert.ok(blocked.runtimeCheck && blocked.runtimeCheck.ok === false);

    const allowed = install.plan(env.target, { appRoot: env.appRoot, allowUnknownNeural: true });
    assert.strictEqual(allowed.installable, true, allowed.problems.join(' '));
    assert.ok(allowed.notes.some(n => /Allowed by your setting/.test(n)));

    withKnown(env.runtime, () => {
      const known = install.plan(env.target, { appRoot: env.appRoot });
      assert.strictEqual(known.installable, true, known.problems.join(' '));
      assert.strictEqual(known.runtimeCheck.details.nr.known, true);
    });
  } finally { env.cleanup(); }
});

test('an unknown SR or FG runtime is a note, never a refusal', () => {
  const env = scaffold();
  try {
    fs.writeFileSync(path.join(env.appRoot, 'runtimes', 'nvngx_dlss.dll'), Buffer.alloc(5 * 1024 * 1024, 3));
    withKnown(env.runtime, () => {
      const planned = install.plan(env.target, { appRoot: env.appRoot });
      assert.strictEqual(planned.installable, true, planned.problems.join(' '));
      assert.ok(planned.notes.some(n => /nvngx_dlss\.dll.*not the version this build was validated with/.test(n)), planned.notes.join('\n'));
    });
  } finally { env.cleanup(); }
});

test('verify sees a game update overwrite the add-on, and status reports it', () => {
  const env = scaffold();
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot, allowUnknownNeural: true });
    install.apply(planned, { logFile: env.logFile });
    let check = install.verify(env.gameDir);
    assert.strictEqual(check.gameUpdated, false);
    assert.ok(check.intact.length >= 2, `intact: ${check.intact.length}`);
    assert.strictEqual(check.unknown.length, 0);

    fs.writeFileSync(path.join(env.gameDir, 'dxgi.dll'), 'A GAME PATCH REPLACED THIS');
    check = install.verify(env.gameDir);
    assert.strictEqual(check.gameUpdated, true);
    assert.deepStrictEqual(check.changed, [path.join(env.gameDir, 'dxgi.dll')]);
    assert.match(check.summary, /have changed since the install/);
    const state = install.status(env.gameDir);
    assert.strictEqual(state.intact, false);
    assert.deepStrictEqual(state.changedSinceInstall, [path.join(env.gameDir, 'dxgi.dll')]);
  } finally { env.cleanup(); }
});

test('restore leaves a file the game updated alone unless forced', () => {
  const env = scaffold();
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot, allowUnknownNeural: true });
    install.apply(planned, { logFile: env.logFile });
    fs.writeFileSync(path.join(env.gameDir, 'dxgi.dll'), 'A GAME PATCH REPLACED THIS');

    const result = install.restore(env.gameDir);
    assert.deepStrictEqual(result.skipped, [path.join(env.gameDir, 'dxgi.dll')]);
    assert.strictEqual(fs.readFileSync(path.join(env.gameDir, 'dxgi.dll'), 'utf8'), 'A GAME PATCH REPLACED THIS');
    assert.ok(!fs.existsSync(path.join(env.gameDir, 'standalone-dlssnr.addon64')), 'our own untouched files still go');
    assert.ok(result.failures.some(f => /changed after the install/.test(f)));

    // Reinstall, then force: the game's true original comes back.
    const again = install.plan(env.target, { appRoot: env.appRoot, allowUnknownNeural: true });
    install.apply(again, { logFile: env.logFile });
    const forced = install.restore(env.gameDir, { force: true });
    assert.strictEqual(forced.skipped.length, 0);
  } finally { env.cleanup(); }
});

test('a reinstall keeps the first original, not our own previous file', () => {
  const env = scaffold();
  try {
    const first = install.plan(env.target, { appRoot: env.appRoot, allowUnknownNeural: true });
    const m1 = install.apply(first, { logFile: env.logFile });
    const dxgi = path.join(env.gameDir, 'dxgi.dll');
    assert.strictEqual(fs.readFileSync(dxgi, 'utf8'), 'RESHADE PAYLOAD');

    // A newer payload, installed over the first.
    fs.writeFileSync(path.join(env.appRoot, 'payload', 'ReShade64.dll'), 'RESHADE PAYLOAD v2');
    const second = install.plan(env.target, { appRoot: env.appRoot, allowUnknownNeural: true });
    const m2 = install.apply(second, { logFile: env.logFile });
    assert.strictEqual(fs.readFileSync(dxgi, 'utf8'), 'RESHADE PAYLOAD v2');
    const record = m2.records.find(r => r.target === dxgi);
    assert.strictEqual(record.firstOriginalFrom, m1.transaction, 'the record points back at the first transaction');
    assert.strictEqual(fs.readFileSync(record.backup, 'utf8'), 'THE GAMES OWN DXGI');

    const result = install.restore(env.gameDir);
    assert.strictEqual(result.skipped.length, 0);
    assert.strictEqual(fs.readFileSync(dxgi, 'utf8'), 'THE GAMES OWN DXGI');
  } finally { env.cleanup(); }
});

test('a folder that cannot be written is refused before any backup starts', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const env = scaffold();
  try {
    fs.chmodSync(env.gameDir, 0o555);
    const planned = install.plan(env.target, { appRoot: env.appRoot, allowUnknownNeural: true });
    assert.strictEqual(planned.installable, false);
    assert.ok(planned.problems.some(p => /not writable/.test(p)), planned.problems.join(' '));
    const xbox = install.plan({ ...env.target, store: 'Xbox' }, { appRoot: env.appRoot, allowUnknownNeural: true });
    assert.ok(xbox.problems.some(p => /Enable mod support/.test(p)), xbox.problems.join(' '));
  } finally { fs.chmodSync(env.gameDir, 0o755); env.cleanup(); }
});

test('the signature check reports honestly off Windows and parses PowerShell on it', () => {
  assert.deepStrictEqual(authenticode.signature('x.dll', { platform: 'linux' }), { status: 'unavailable', signer: null, reason: 'not Windows' });
  const fake = () => ({ status: 0, stdout: 'Valid|CN=NVIDIA Corporation, O=NVIDIA Corporation, L=Santa Clara, S=California, C=US', stderr: '' });
  const sig = authenticode.signature('C:\\x\\nvngx_dlssnr.dll', { platform: 'win32', run: fake });
  assert.deepStrictEqual(sig, { status: 'Valid', signer: 'NVIDIA Corporation' });
  assert.strictEqual(authenticode.describe(sig).tone, 'on');
  const tampered = authenticode.signature('C:\\x\\nvngx_dlssnr.dll', { platform: 'win32', run: () => ({ status: 0, stdout: 'HashMismatch|CN=NVIDIA Corporation', stderr: '' }) });
  assert.strictEqual(authenticode.describe(tampered).tone, 'bad');
  const broken = authenticode.signature('C:\\x\\nvngx_dlssnr.dll', { platform: 'win32', run: () => ({ status: 1, stdout: '', stderr: 'boom' }) });
  assert.strictEqual(broken.status, 'unavailable');
  assert.strictEqual(journal.sha256(__filename), runtimes.sha256(__filename), 'the two hashers agree');
});
