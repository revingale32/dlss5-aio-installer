// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// The fake 41 MB neural runtime these tests scaffold has no known-good hash;
// the gate that refuses unknown copies is tested on its own in hardening.test.js.
process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const install = require('../core/install');
const journal = require('../core/journal');
const ini = require('../core/ini');

// A throwaway app root with a complete payload, and a throwaway game folder.
function scaffold({ withRuntime = true, existingIni = null, anticheat = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-'));
  const appRoot = path.join(root, 'app');
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(path.join(appRoot, 'payload'), { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'runtimes'), { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });

  fs.writeFileSync(path.join(appRoot, 'payload', 'ReShade64.dll'), 'RESHADE PAYLOAD');
  fs.writeFileSync(path.join(appRoot, 'payload', 'ReShade32.dll'), 'RESHADE32 PAYLOAD');
  fs.writeFileSync(path.join(appRoot, 'payload', 'nvngx.dll'), 'BRIDGE PAYLOAD');
  // The add-on carries its version in its name string; the fake does too.
  fs.writeFileSync(path.join(appRoot, 'payload', 'standalone-dlssnr.addon64'), 'ADDON PAYLOAD Standalone DLSS-NR + SR 2.2.4-revin4 end');
  fs.mkdirSync(path.join(appRoot, 'payload', 'relay'));
  fs.writeFileSync(path.join(appRoot, 'payload', 'relay', 'neural-relay.exe'), 'RELAY');
  fs.writeFileSync(path.join(appRoot, 'payload', 'relay', 'neural-relay-launcher.addon32'), 'LAUNCHER');
  fs.mkdirSync(path.join(appRoot, 'payload', 'shaders'));
  fs.writeFileSync(path.join(appRoot, 'payload', 'shaders', 'StandaloneBoundary.fx'), 'fx');
  // The machine-wide folder the runtime set is assembled in, per test.
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  if (withRuntime) {
    // Big enough to pass the plausibility floor without writing 158 MB.
    fs.writeFileSync(path.join(appRoot, 'runtimes', 'nvngx_dlssnr.dll'),
      Buffer.alloc(41 * 1024 * 1024, 1));
  }
  fs.writeFileSync(path.join(gameDir, 'game.exe'), 'GAME');
  if (existingIni !== null) fs.writeFileSync(path.join(gameDir, 'ReShade.ini'), existingIni);
  if (anticheat) fs.mkdirSync(path.join(gameDir, anticheat), { recursive: true });

  const target = {
    dir: gameDir,
    exe: { file: path.join(gameDir, 'game.exe'), name: 'game.exe', bitness: 64, api: 'd3d12', renders: true },
  };
  // A log far in the past, so the "is a game running" guard stays quiet.
  const logFile = path.join(root, 'standalone-dlssnr.log');
  fs.writeFileSync(logFile, 'old');
  fs.utimesSync(logFile, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));

  const machineWide = path.join(process.env.LOCALAPPDATA, 'RHI', 'Custom', 'Addons');
  return {
    root, appRoot, gameDir, target, logFile, machineWide,
    cleanup: () => {
      if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a clean install places the files and writes our section', () => {
  const env = scaffold();
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.strictEqual(planned.installable, true, planned.problems.join(' '));
    assert.strictEqual(planned.hook, 'dxgi.dll');

    const manifest = install.apply(planned, { logFile: env.logFile });
    assert.strictEqual(manifest.installed, true);
    assert.ok(fs.existsSync(path.join(env.gameDir, 'dxgi.dll')));
    assert.ok(fs.existsSync(path.join(env.gameDir, 'standalone-dlssnr.addon64')));
    // The runtime set is assembled machine-wide, in one folder, never half in the game folder.
    assert.ok(!fs.existsSync(path.join(env.gameDir, 'nvngx_dlssnr.dll')));
    assert.ok(fs.existsSync(path.join(env.machineWide, 'nvngx_dlssnr.dll')));
    assert.ok(fs.existsSync(path.join(env.machineWide, 'nvngx.dll')));
    assert.deepStrictEqual(manifest.sharedTargets.map(t => path.basename(t)).sort(), ['nvngx.dll', 'nvngx_dlssnr.dll']);
    assert.strictEqual(manifest.route, 'game');
    assert.ok(fs.existsSync(path.join(env.gameDir, 'reshade-shaders', 'Shaders', 'StandaloneBoundary.fx')));

    const section = ini.readSection(path.join(env.gameDir, 'ReShade.ini'), 'Standalone.DLSSNR');
    // A fresh install starts at the lightest settings and lets the user opt up in the
    // overlay: one pass, the cheapest model, frame generation off.
    assert.strictEqual(section.Passes, '1');
    assert.strictEqual(section.Model, '1');
    assert.strictEqual(section.FrameGeneration, '0');
    assert.strictEqual(section.NeuralQueuePriorityHigh, '1');
    assert.strictEqual(section.MouseWarpPixelsPerCount, '0.00');
    assert.strictEqual(install.isInstalled(env.gameDir), true);
  } finally { env.cleanup(); }
});

test('restore puts every original back and removes what we added', () => {
  const env = scaffold({ existingIni: '[GENERAL]\r\nPresetPath=.\\mine.ini\r\n' });
  try {
    fs.writeFileSync(path.join(env.gameDir, 'dxgi.dll'), 'THE USER HAD THEIR OWN');
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    install.apply(planned, { logFile: env.logFile });
    assert.strictEqual(fs.readFileSync(path.join(env.gameDir, 'dxgi.dll'), 'utf8'), 'RESHADE PAYLOAD');

    const result = install.restore(env.gameDir);
    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(fs.readFileSync(path.join(env.gameDir, 'dxgi.dll'), 'utf8'), 'THE USER HAD THEIR OWN',
      'their own dxgi.dll came back, byte for byte');
    assert.ok(fs.readFileSync(path.join(env.gameDir, 'ReShade.ini'), 'utf8').includes('PresetPath=.\\mine.ini'));
    assert.strictEqual(fs.existsSync(path.join(env.gameDir, 'standalone-dlssnr.addon64')), false);
    assert.strictEqual(install.isInstalled(env.gameDir), false);
  } finally { env.cleanup(); }
});

test('an existing ReShade.ini keeps every setting the user had', () => {
  const original = '[GENERAL]\r\nPresetPath=.\\mine.ini\r\n\r\n[Standalone.DLSSNR]\r\nIntensity=1.9000\r\nPasses=3\r\n';
  const env = scaffold({ existingIni: original });
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot, profile: { Passes: '2' } });
    install.apply(planned, { logFile: env.logFile });
    const text = fs.readFileSync(path.join(env.gameDir, 'ReShade.ini'), 'utf8');
    assert.ok(text.includes('PresetPath=.\\mine.ini'), 'their other section survived');
    assert.ok(text.includes('\r\n'), 'still CRLF');
    assert.ok(!/[^\r]\n/.test(text), 'no bare LF introduced');
    const section = ini.readSection(path.join(env.gameDir, 'ReShade.ini'), 'Standalone.DLSSNR');
    assert.strictEqual(section.Passes, '2', 'ours wins where we set it');
  } finally { env.cleanup(); }
});

test('anti-cheat blocks the install until the risk is acknowledged', () => {
  const env = scaffold({ anticheat: 'EasyAntiCheat' });
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.strictEqual(planned.anticheat.present, true);

    assert.throws(() => install.apply(planned, { logFile: env.logFile }), error => {
      assert.strictEqual(error.code, 'ANTICHEAT_CONSENT_REQUIRED');
      assert.match(error.warning, /never bypasses anti-cheat/);
      return true;
    });
    assert.strictEqual(fs.existsSync(path.join(env.gameDir, 'dxgi.dll')), false,
      'nothing was written while consent was outstanding');

    const manifest = install.apply(planned, { acknowledgedAntiCheat: true, logFile: env.logFile });
    assert.deepStrictEqual(manifest.antiCheat, ['EasyAntiCheat']);
  } finally { env.cleanup(); }
});

test('consent is per-install and never remembered', () => {
  const env = scaffold({ anticheat: 'BattlEye' });
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    install.apply(planned, { acknowledgedAntiCheat: true, logFile: env.logFile });
    install.restore(env.gameDir);
    const again = install.plan(env.target, { appRoot: env.appRoot });
    assert.throws(() => install.apply(again, { logFile: env.logFile }),
      error => error.code === 'ANTICHEAT_CONSENT_REQUIRED');
  } finally { env.cleanup(); }
});

test('installing while a game is running is refused, not attempted', () => {
  const env = scaffold();
  try {
    fs.writeFileSync(env.logFile, 'fresh');       // touched just now = running
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.throws(() => install.apply(planned, { logFile: env.logFile }), error => {
      assert.strictEqual(error.code, 'GAME_RUNNING');
      assert.match(error.message, /rewrites its own ReShade.ini on exit/);
      return true;
    });
    assert.strictEqual(fs.existsSync(path.join(env.gameDir, 'dxgi.dll')), false);
  } finally { env.cleanup(); }
});

test('a missing neural runtime is a blocking problem with a clear reason', () => {
  const env = scaffold({ withRuntime: false });
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.strictEqual(planned.installable, false);
    assert.ok(planned.problems.some(p => /nvngx_dlssnr\.dll was not found/.test(p)));
    assert.throws(() => install.apply(planned, { logFile: env.logFile }), /Cannot install/);
  } finally { env.cleanup(); }
});

test('a 32-bit game takes the relay route: launcher beside the game, the relay in its own folder', () => {
  const env = scaffold();
  try {
    const target = { ...env.target, exe: { ...env.target.exe, bitness: 32, api: 'd3d11' } };
    const planned = install.plan(target, { appRoot: env.appRoot });
    assert.strictEqual(planned.installable, true, planned.problems.join(' '));
    assert.strictEqual(planned.route, 'relay');
    assert.strictEqual(planned.hook, 'dxgi.dll');
    assert.ok(planned.notes.some(n => /32-bit.*neural relay/.test(n)));

    const manifest = install.apply(planned, { logFile: env.logFile, appRoot: env.appRoot });
    assert.strictEqual(manifest.route, 'relay');
    assert.strictEqual(fs.readFileSync(path.join(env.gameDir, 'dxgi.dll'), 'utf8'), 'RESHADE32 PAYLOAD', 'the 32-bit ReShade hooks the game');
    assert.ok(fs.existsSync(path.join(env.gameDir, 'neural-relay-launcher.addon32')));
    assert.ok(!fs.existsSync(path.join(env.gameDir, 'standalone-dlssnr.addon64')), 'the 64-bit add-on never goes into a 32-bit game');
    const relayDir = path.join(env.gameDir, 'neural-relay');
    assert.strictEqual(fs.readFileSync(path.join(relayDir, 'dxgi.dll'), 'utf8'), 'RESHADE PAYLOAD', 'the 64-bit ReShade hooks the relay');
    assert.ok(fs.existsSync(path.join(relayDir, 'neural-relay.exe')));
    assert.ok(fs.existsSync(path.join(relayDir, 'standalone-dlssnr.addon64')));
    const launcher = ini.readSection(path.join(env.gameDir, 'neural-relay-launcher.ini'), 'NeuralRelay');
    assert.strictEqual(launcher.FpsCap, 'auto');
    assert.strictEqual(launcher.Path, undefined, 'no absolute path: the launcher finds neural-relay\\ beside itself');
    const relayProfile = ini.readSection(path.join(relayDir, 'ReShade.ini'), 'Standalone.DLSSNR');
    assert.strictEqual(relayProfile.OpaqueComposition, '1', 'the overlay must be opaque');
    assert.strictEqual(relayProfile.Passes, '1');
    assert.strictEqual(relayProfile.Model, '1');
    const gameIni = fs.readFileSync(path.join(env.gameDir, 'ReShade.ini'), 'utf8');
    assert.ok(!/Standalone\.DLSSNR/.test(gameIni), 'the profile lives with the relay, not in the 32-bit game');
    assert.strictEqual(install.status(env.gameDir).route, 'relay');

    const outcome = install.restore(env.gameDir);
    assert.deepStrictEqual(outcome.failures, []);
    assert.ok(!fs.existsSync(relayDir + '/neural-relay.exe'));
    assert.ok(!fs.existsSync(path.join(env.gameDir, 'neural-relay-launcher.addon32')));
    assert.ok(!fs.existsSync(path.join(env.gameDir, 'dxgi.dll')));
  } finally { env.cleanup(); }
});

test('a kit that is already on disk is reported as installed but not managed', () => {
  const env = scaffold();
  try {
    assert.deepStrictEqual(install.status(env.gameDir).installed, false);
    fs.writeFileSync(path.join(env.gameDir, 'standalone-dlssnr.addon64'), 'x Standalone DLSS-NR + SR 2.2.3-revin2 y');
    fs.writeFileSync(path.join(env.gameDir, 'ReShade.ini'), '[Standalone.DLSSNR]\r\nPasses=2\r\n');
    const found = install.status(env.gameDir);
    assert.deepStrictEqual({ installed: found.installed, managed: found.managed, route: found.route, build: found.build },
      { installed: true, managed: false, route: 'game', build: '2.2.3-revin2' });
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.strictEqual(planned.alreadyInstalled, true);
    assert.ok(planned.notes.some(n => /not\s+installed by this app/.test(n)));

    // A relay install by hand: the launcher plus an ini pointing elsewhere.
    const other = scaffold();
    try {
      fs.writeFileSync(path.join(other.gameDir, 'neural-relay-launcher.addon32'), 'L');
      const relayDir = path.join(other.root, 'somewhere', 'relay');
      fs.mkdirSync(relayDir, { recursive: true });
      fs.writeFileSync(path.join(relayDir, 'neural-relay.exe'), 'R');
      fs.writeFileSync(path.join(relayDir, 'standalone-dlssnr.addon64'), 'Standalone DLSS-NR + SR 2.2.4-revin4');
      fs.writeFileSync(path.join(other.gameDir, 'neural-relay-launcher.ini'), `[NeuralRelay]\r\nPath=${path.join(relayDir, 'neural-relay.exe')}\r\nFpsCap=auto\r\n`);
      const relay = install.status(other.gameDir);
      assert.deepStrictEqual({ installed: relay.installed, managed: relay.managed, route: relay.route, build: relay.build },
        { installed: true, managed: false, route: 'relay', build: '2.2.4-revin4' });
    } finally { other.cleanup(); }
  } finally { env.cleanup(); }
});

test('restoring one game leaves the machine-wide runtime set for the others', () => {
  const env = scaffold();
  try {
    install.apply(install.plan(env.target, { appRoot: env.appRoot }), { logFile: env.logFile });
    const outcome = install.restore(env.gameDir);
    assert.deepStrictEqual(outcome.failures, []);
    assert.ok(outcome.left.length >= 2, 'the shared files are reported as left in place');
    assert.ok(fs.existsSync(path.join(env.machineWide, 'nvngx_dlssnr.dll')));
    assert.ok(fs.existsSync(path.join(env.machineWide, 'nvngx.dll')));
    assert.ok(!fs.existsSync(path.join(env.gameDir, 'standalone-dlssnr.addon64')));
  } finally { env.cleanup(); }
});

test('a failed install leaves nothing behind', () => {
  const env = scaffold();
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    // The add-on vanishes between planning and applying.
    fs.rmSync(path.join(env.appRoot, 'payload', 'standalone-dlssnr.addon64'));
    assert.throws(() => install.apply(planned, { logFile: env.logFile }));
    assert.strictEqual(fs.existsSync(path.join(env.gameDir, 'dxgi.dll')), false,
      'the file written before the failure was rolled back');
    assert.strictEqual(fs.existsSync(path.join(env.gameDir, 'ReShade.ini')), false);
    assert.strictEqual(journal.pendingTransactions(env.gameDir).length, 0);
  } finally { env.cleanup(); }
});

test('a DX9 game is hooked as d3d9, not dxgi', () => {
  const env = scaffold();
  try {
    const target = { ...env.target, exe: { ...env.target.exe, api: 'd3d9' } };
    assert.strictEqual(install.plan(target, { appRoot: env.appRoot }).hook, 'd3d9.dll');
  } finally { env.cleanup(); }
});

test('history records the install and the restore', () => {
  const env = scaffold();
  try {
    install.apply(install.plan(env.target, { appRoot: env.appRoot }), { logFile: env.logFile });
    install.restore(env.gameDir);
    const log = install.history(env.gameDir);
    assert.deepStrictEqual(log.map(e => e.action), ['install', 'restore']);
  } finally { env.cleanup(); }
});

test('a game with plain native DLSS stays on our kit and is told to keep its own frame gen off', () => {
  const env = scaffold();
  try {
    // GTA V Enhanced's shape: Streamline + DLSS SR/FG in the folder, no ray reconstruction.
    fs.writeFileSync(path.join(env.gameDir, 'nvngx_dlss.dll'), 'GAME SR');
    fs.writeFileSync(path.join(env.gameDir, 'nvngx_dlssg.dll'), 'GAME FG');
    fs.writeFileSync(path.join(env.gameDir, 'sl.interposer.dll'), 'STREAMLINE');

    assert.deepStrictEqual(install.engineOwnedNeural(env.gameDir).map(r => r.file).sort(),
      ['nvngx_dlss.dll', 'nvngx_dlssg.dll', 'sl.interposer.dll']);
    assert.deepStrictEqual(install.nativeRayReconstruction(env.gameDir), []);

    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.strictEqual(planned.route, 'game', 'native DLSS alone does not change the route');
    const note = planned.notes.find(n => /has DLSS built in/.test(n));
    assert.ok(note, 'a calm note, not a warning');
    assert.ok(/frame generation OFF/.test(note));
    assert.ok(!planned.notes.some(n => /PRAGMATA/.test(n)), 'no Pragmata scare for a game that works');
    assert.strictEqual(planned.installable, true);
  } finally { env.cleanup(); }
});

test('an ordinary game gets no engine-neural warning', () => {
  const env = scaffold();
  try {
    assert.deepStrictEqual(install.engineOwnedNeural(env.gameDir), []);
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.ok(!planned.notes.some(n => /ships its own neural rendering/.test(n)));
  } finally { env.cleanup(); }
});
