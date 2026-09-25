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
const cp = require('child_process');

const projectRoot = path.join(__dirname, '..');

// A whole app, a whole game, driven only through the command line - the same
// path the UI will call. If this passes, the installer works end to end.
function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const app = path.join(root, 'app');
  const game = path.join(root, 'MyGame');
  fs.mkdirSync(path.join(app, 'payload'), { recursive: true });
  fs.mkdirSync(path.join(app, 'runtimes'), { recursive: true });
  fs.mkdirSync(path.join(app, 'cli'), { recursive: true });
  fs.mkdirSync(path.join(app, 'core'), { recursive: true });
  for (const file of fs.readdirSync(path.join(projectRoot, 'core'))) {
    fs.copyFileSync(path.join(projectRoot, 'core', file), path.join(app, 'core', file));
  }
  fs.copyFileSync(path.join(projectRoot, 'cli', 'cli.js'), path.join(app, 'cli', 'cli.js'));
  fs.writeFileSync(path.join(app, 'payload', 'ReShade64.dll'), 'RESHADE');
  fs.copyFileSync(path.join(projectRoot, 'test', 'fixtures', 'standalone-dlssnr.addon64'),
    path.join(app, 'payload', 'standalone-dlssnr.addon64'));
  fs.writeFileSync(path.join(app, 'runtimes', 'nvngx_dlssnr.dll'), Buffer.alloc(41 * 1024 * 1024, 1));

  fs.mkdirSync(game, { recursive: true });
  // A real 64-bit PE that imports d3d12, so detection is exercised for real.
  fs.copyFileSync(path.join(projectRoot, 'test', 'fixtures', 'standalone-dlssnr.addon64'),
    path.join(game, 'MyGame.exe'));
  fs.writeFileSync(path.join(game, 'ReShade.ini'), '[GENERAL]\r\nPresetPath=.\\mine.ini\r\n');

  const run = (...args) => cp.spawnSync(process.execPath, [path.join(app, 'cli', 'cli.js'), ...args],
    { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: path.join(root, 'local') } });

  return { root, app, game, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('install then restore leaves the folder as it was found', () => {
  const env = stage();
  try {
    const planned = env.run('plan', env.game);
    assert.strictEqual(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /MyGame\.exe \(d3d12, 64-bit\)/);
    assert.match(planned.stdout, /hook as:\s+dxgi\.dll/);

    const installed = env.run('install', env.game, '--passes', '3');
    assert.strictEqual(installed.status, 0, installed.stderr);
    assert.ok(fs.existsSync(path.join(env.game, 'dxgi.dll')));
    assert.ok(fs.existsSync(path.join(env.game, 'standalone-dlssnr.addon64')));

    const text = fs.readFileSync(path.join(env.game, 'ReShade.ini'), 'utf8');
    assert.ok(text.includes('PresetPath=.\\mine.ini'), 'their own setting survived');
    assert.ok(text.includes('Passes=3'), '--passes reached the ini');
    assert.ok(!/[^\r]\n/.test(text), 'still CRLF throughout');

    assert.match(env.run('status', env.game).stdout, /installed: true/);

    const restored = env.run('restore', env.game);
    assert.strictEqual(restored.status, 0, restored.stderr);
    assert.strictEqual(fs.existsSync(path.join(env.game, 'dxgi.dll')), false);
    assert.strictEqual(fs.existsSync(path.join(env.game, 'standalone-dlssnr.addon64')), false);
    assert.strictEqual(fs.readFileSync(path.join(env.game, 'ReShade.ini'), 'utf8'),
      '[GENERAL]\r\nPresetPath=.\\mine.ini\r\n', 'the ini is byte-identical to before');
  } finally { env.cleanup(); }
});

test('a dry run writes nothing', () => {
  const env = stage();
  try {
    const result = env.run('install', env.game, '--dry-run');
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /dry run: nothing was written/);
    assert.strictEqual(fs.existsSync(path.join(env.game, 'dxgi.dll')), false);
  } finally { env.cleanup(); }
});

test('an anti-cheat folder is refused with exit code 2 until acknowledged', () => {
  const env = stage();
  try {
    fs.mkdirSync(path.join(env.game, 'EasyAntiCheat'));
    const refused = env.run('install', env.game);
    assert.strictEqual(refused.status, 2);
    assert.match(refused.stderr, /never bypasses anti-cheat/);
    assert.strictEqual(fs.existsSync(path.join(env.game, 'dxgi.dll')), false);

    const accepted = env.run('install', env.game, '--accept-anticheat');
    assert.strictEqual(accepted.status, 0, accepted.stderr);
  } finally { env.cleanup(); }
});

test('a missing runtime fails the plan with a readable reason', () => {
  const env = stage();
  try {
    fs.rmSync(path.join(env.app, 'runtimes', 'nvngx_dlssnr.dll'));
    const result = env.run('plan', env.game);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /nvngx_dlssnr\.dll was not found/);
  } finally { env.cleanup(); }
});

test('an unknown folder is reported, not crashed on', () => {
  const env = stage();
  try {
    const result = env.run('plan', path.join(env.root, 'nope'));
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /No such folder/);
  } finally { env.cleanup(); }
});
