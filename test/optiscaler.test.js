// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const install = require('../core/install');
const runtimes = require('../core/runtimes');
const ini = require('../core/ini');

// A throwaway app root whose payload carries a fake OptiScaler build laid out
// like the real release archive, and a game folder shaped like PRAGMATA.
function scaffold({ rayReconstruction = true, api = 'd3d12', bitness = 64, foreignDxgi = false, standaloneKit = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-opti-'));
  const appRoot = path.join(root, 'app');
  const gameDir = path.join(root, 'game');
  const payload = path.join(appRoot, 'payload');
  fs.mkdirSync(path.join(payload, 'optiscaler', 'OptiScaler', 'dlssnr'), { recursive: true });
  fs.mkdirSync(path.join(payload, 'optiscaler', 'OptiScaler', 'D3D12_OptiScaler'), { recursive: true });
  fs.mkdirSync(path.join(payload, 'shaders'), { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'runtimes'), { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });

  // our own standalone payload (the plan checks the pieces the chosen route needs)
  fs.writeFileSync(path.join(payload, 'ReShade64.dll'), 'RESHADE PAYLOAD');
  fs.writeFileSync(path.join(payload, 'ReShade32.dll'), 'RESHADE32 PAYLOAD');
  fs.writeFileSync(path.join(payload, 'nvngx.dll'), 'BRIDGE PAYLOAD');
  fs.writeFileSync(path.join(payload, 'standalone-dlssnr.addon64'), 'ADDON Standalone DLSS-NR + SR 2.2.4-revin10b end');
  fs.writeFileSync(path.join(payload, 'shaders', 'StandaloneBoundary.fx'), 'fx');
  // the OptiScaler build
  fs.writeFileSync(path.join(payload, 'optiscaler', 'OptiScaler.dll'), 'OPTISCALER PROXY DLL');
  fs.writeFileSync(path.join(payload, 'optiscaler', 'OptiScaler.ini'),
    '[Upscalers]\r\n; Select Upscaler for Dx12 games\r\nDx12Upscaler=auto\r\n\r\n[DlssNr]\r\n; DLSS 5 Neural Rendering.\r\nEnabled=auto\r\nRunBeforeSR=auto\r\nPasses=auto\r\nWorkingScale=auto\r\n\r\n[ProcessFilter]\r\nTargetProcessName=auto\r\n\r\n[Log]\r\nLogToFile=auto\r\nLogLevel=auto\r\n');
  fs.writeFileSync(path.join(payload, 'optiscaler', 'OptiScaler', 'dlssnr', 'README.md'), '# NR');
  fs.writeFileSync(path.join(payload, 'optiscaler', 'OptiScaler', 'D3D12_OptiScaler', 'D3D12Core.dll'), 'AGILITY');
  fs.writeFileSync(path.join(payload, 'optiscaler', 'OptiScaler', 'libxess.dll'), 'XESS');

  const previousLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  const previousAllow = process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME;
  process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME = '1';
  fs.writeFileSync(path.join(appRoot, 'runtimes', 'nvngx_dlssnr.dll'), Buffer.alloc(41 * 1024 * 1024, 1));

  fs.writeFileSync(path.join(gameDir, 'PRAGMATA.exe'), 'GAME');
  // the game's own DLSS stack, as shipped
  for (const f of ['nvngx_dlss.dll', 'nvngx_dlssg.dll', 'sl.interposer.dll', 'sl.common.dll', 'sl.dlss.dll']) fs.writeFileSync(path.join(gameDir, f), 'game');
  if (rayReconstruction) for (const f of ['nvngx_dlssd.dll', 'sl.dlss_d.dll']) fs.writeFileSync(path.join(gameDir, f), 'game rr');
  if (foreignDxgi) fs.writeFileSync(path.join(gameDir, 'dxgi.dll'), 'SOMEBODY ELSES LOADER');
  if (standaloneKit) {
    fs.writeFileSync(path.join(gameDir, 'dxgi.dll'), 'RESHADE PAYLOAD');
    fs.writeFileSync(path.join(gameDir, 'standalone-dlssnr.addon64'), 'ADDON Standalone DLSS-NR + SR 2.2.4-revin10b end');
    fs.writeFileSync(path.join(gameDir, 'ReShade.ini'), '[Standalone.DLSSNR]\r\nPasses=1\r\n');
  }

  const target = {
    dir: gameDir,
    exe: { file: path.join(gameDir, 'PRAGMATA.exe'), name: 'PRAGMATA.exe', bitness, api, renders: true },
  };
  const logFile = path.join(root, 'old.log');
  fs.writeFileSync(logFile, 'old');
  fs.utimesSync(logFile, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  return {
    root, appRoot, gameDir, target, logFile,
    cleanup: () => {
      if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
      if (previousAllow === undefined) delete process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME; else process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME = previousAllow;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('native ray reconstruction is what selects the OptiScaler route, and only for 64-bit D3D12', () => {
  const env = scaffold();
  try {
    assert.deepStrictEqual(install.nativeRayReconstruction(env.gameDir), ['nvngx_dlssd.dll', 'sl.dlss_d.dll']);
    assert.strictEqual(install.routeFor(env.target.exe, env.gameDir), 'optiscaler');
    assert.strictEqual(install.routeFor({ ...env.target.exe, api: 'd3d11' }, env.gameDir), 'optiscaler', 'RE Engine reads as D3D11 from imports; ray reconstruction says otherwise');
    assert.strictEqual(install.routeFor({ ...env.target.exe, api: 'unknown' }, env.gameDir), 'optiscaler');
    assert.strictEqual(install.routeFor({ ...env.target.exe, api: 'd3d9' }, env.gameDir), 'game', 'OptiScaler cannot host D3D9');
    assert.strictEqual(install.routeFor({ ...env.target.exe, bitness: 32 }, env.gameDir), 'relay', '32-bit still goes to the relay');
    assert.strictEqual(install.routeFor(env.target.exe, env.gameDir, { route: 'game' }), 'game', 'the person can force our kit');
    assert.strictEqual(install.routeFor(env.target.exe, env.gameDir, { route: 'optiscaler' }), 'optiscaler');
  } finally { env.cleanup(); }
});

test('a game without ray reconstruction never takes the OptiScaler route by itself', () => {
  const env = scaffold({ rayReconstruction: false });
  try {
    assert.strictEqual(install.routeFor(env.target.exe, env.gameDir), 'game');
    assert.strictEqual(install.routeFor(env.target.exe, env.gameDir, { route: 'optiscaler' }), 'optiscaler', 'unless asked');
  } finally { env.cleanup(); }
});

test('the OptiScaler plan lays the fork beside the game with the user\'s own runtime and the right ini', () => {
  const env = scaffold();
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.strictEqual(planned.route, 'optiscaler');
    assert.strictEqual(planned.installable, true, planned.problems.join(' '));
    const targets = planned.files.map(f => path.relative(env.gameDir, f.to).replace(/\\/g, '/'));
    assert.ok(targets.includes('dxgi.dll'), 'OptiScaler loads as dxgi.dll');
    assert.strictEqual(planned.files.find(f => /dxgi\.dll$/.test(f.to)).from, path.join(env.appRoot, 'payload', 'optiscaler', 'OptiScaler.dll'));
    assert.ok(targets.includes('OptiScaler/dlssnr/README.md'), 'backend folder comes along');
    assert.ok(targets.includes('OptiScaler/D3D12_OptiScaler/D3D12Core.dll'));
    assert.ok(targets.includes('nvngx_dlssnr.dll'), 'the runtime is copied beside the proxy');
    assert.ok(!targets.includes('standalone-dlssnr.addon64'), 'our add-on is not installed on this route');
    assert.ok(!planned.files.some(f => /ReShade64/.test(f.from) && !/parked/.test(f.to)), 'ReShade is not installed on this route');
    const edit = planned.iniEdits.find(e => /OptiScaler\.ini$/.test(e.file));
    assert.ok(edit, 'OptiScaler.ini is edited');
    assert.deepStrictEqual(edit.sections.DlssNr, { Enabled: 'true', RunBeforeSR: 'true', Passes: '1', WorkingScale: '1.0' });
    assert.ok(edit.template, 'the shipped ini is the base, comments and all');
    assert.ok(planned.notes.some(n => /OptiScaler route/.test(n) && /ray reconstruction/.test(n)));
    assert.ok(!planned.notes.some(n => /has DLSS built in/.test(n)), 'the calm native-DLSS note is for our own route only');
  } finally { env.cleanup(); }
});

test('apply, detect and restore round-trip the OptiScaler route', () => {
  const env = scaffold();
  try {
    const before = fs.readdirSync(env.gameDir).sort();
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    const manifest = install.apply(planned, { logFile: env.logFile, appRoot: env.appRoot });
    assert.strictEqual(manifest.route, 'optiscaler');
    assert.strictEqual(fs.readFileSync(path.join(env.gameDir, 'dxgi.dll'), 'utf8'), 'OPTISCALER PROXY DLL');
    assert.ok(fs.existsSync(path.join(env.gameDir, 'OptiScaler', 'dlssnr', 'README.md')));
    assert.ok(fs.existsSync(path.join(env.gameDir, 'nvngx_dlssnr.dll')));

    const text = fs.readFileSync(path.join(env.gameDir, 'OptiScaler.ini'), 'utf8');
    assert.ok(text.includes('; DLSS 5 Neural Rendering.'), 'the shipped comments survived');
    assert.ok(text.includes('\r\n'), 'CRLF kept');
    const nr = ini.readSectionFrom(text, 'DlssNr');
    assert.strictEqual(nr.Enabled, 'true');
    assert.strictEqual(nr.RunBeforeSR, 'true');
    assert.strictEqual(nr.Passes, '1');
    assert.strictEqual(ini.readSectionFrom(text, 'ProcessFilter').TargetProcessName, 'auto');
    assert.strictEqual(ini.readSectionFrom(text, 'Log').LogToFile, 'true');

    assert.strictEqual(install.detect(env.gameDir).route, 'optiscaler');
    assert.strictEqual(install.status(env.gameDir).route, 'optiscaler');
    assert.strictEqual(install.status(env.gameDir).managed, true);

    const outcome = install.restore(env.gameDir);
    assert.deepStrictEqual(outcome.failures, []);
    const after = fs.readdirSync(env.gameDir).filter(n => n !== '.dlss5-aio').sort();
    assert.deepStrictEqual(after, before, 'the game folder is exactly what it was');
    assert.strictEqual(install.status(env.gameDir).installed, false);
  } finally { env.cleanup(); }
});

test('two neural injectors never coexist: an existing standalone kit is parked and restored', () => {
  const env = scaffold({ standaloneKit: true });
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    assert.strictEqual(planned.route, 'optiscaler');
    const parked = planned.files.filter(f => f.action === 'park').map(f => path.basename(f.from)).sort();
    assert.deepStrictEqual(parked, ['ReShade.ini', 'standalone-dlssnr.addon64']);
    install.apply(planned, { logFile: env.logFile, appRoot: env.appRoot });
    assert.ok(!fs.existsSync(path.join(env.gameDir, 'standalone-dlssnr.addon64')));
    assert.ok(fs.existsSync(path.join(env.gameDir, 'standalone-dlssnr.addon64.dlss5-parked')));
    assert.strictEqual(fs.readFileSync(path.join(env.gameDir, 'dxgi.dll'), 'utf8'), 'OPTISCALER PROXY DLL', 'our ReShade in dxgi.dll was replaced, with a backup');

    const outcome = install.restore(env.gameDir);
    assert.deepStrictEqual(outcome.failures, []);
    assert.strictEqual(fs.readFileSync(path.join(env.gameDir, 'dxgi.dll'), 'utf8'), 'RESHADE PAYLOAD');
    assert.ok(fs.existsSync(path.join(env.gameDir, 'standalone-dlssnr.addon64')));
    assert.ok(!fs.existsSync(path.join(env.gameDir, 'standalone-dlssnr.addon64.dlss5-parked')));
  } finally { env.cleanup(); }
});

test('a foreign dxgi.dll makes OptiScaler load as winmm.dll instead of colliding', () => {
  const env = scaffold({ foreignDxgi: true });
  try {
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    const proxy = planned.files.find(f => /OptiScaler\.dll$/.test(f.from));
    assert.strictEqual(path.basename(proxy.to), 'winmm.dll');
    assert.ok(!planned.files.some(f => /dxgi\.dll$/.test(f.to)), 'the other loader\'s dxgi.dll is left alone');
  } finally { env.cleanup(); }
});

test('the cross-generation runtime is accepted by hash, flagged as modified, and waives the Blackwell gate', () => {
  const env = scaffold();
  const file = path.join(env.appRoot, 'runtimes', 'nvngx_dlssnr.dll');
  const sha = runtimes.sha256(file);
  // Stand in for the published hash with this fake file's own, flagged the same way.
  runtimes.KNOWN_GOOD.nr[sha] = { version: '310.8.0.0', bytes: null, modified: true, label: 'cross-generation build (test)' };
  try {
    const check = runtimes.verify({ nr: { file, from: env.appRoot, bytes: fs.statSync(file).size } });
    assert.strictEqual(check.ok, true);
    assert.strictEqual(check.details.nr.modified, true);
    assert.ok(check.notes.some(n => /community-modified/.test(n) && /RTX 3080/.test(n)));

    // A readiness probe that says "this card cannot run it" - the message the machine check
    // produces for a Turing card against the stock export - is waived for this file.
    const probe = () => ({ problems: ['This PC\'s GPU is Turing. nvngx_dlssnr.dll 310.8.0.0 needs Blackwell. There is nothing to install.'], notes: [], gpu: null });
    const planned = install.plan(env.target, { appRoot: env.appRoot, probe });
    assert.strictEqual(planned.installable, true, planned.problems.join(' '));
    assert.ok(planned.notes.some(n => /needs Blackwell.*waived|"needs Blackwell" check is waived/.test(n)));
  } finally {
    delete runtimes.KNOWN_GOOD.nr[sha];
    env.cleanup();
  }
});

test('an OptiScaler update that drops a backend file still restores cleanly', () => {
  const env = scaffold();
  try {
    const oldOnly = path.join(env.appRoot, 'payload', 'optiscaler', 'OptiScaler', 'dlssnr', 'old-only.md');
    fs.writeFileSync(oldOnly, 'shipped by the older release only');
    const before = fs.readdirSync(env.gameDir).sort();
    install.apply(install.plan(env.target, { appRoot: env.appRoot }), { logFile: env.logFile, appRoot: env.appRoot });
    const installedOldOnly = path.join(env.gameDir, 'OptiScaler', 'dlssnr', 'old-only.md');
    assert.ok(fs.existsSync(installedOldOnly));

    // the newer payload no longer has it; OptiScaler's own settings changed in between
    fs.rmSync(oldOnly);
    fs.writeFileSync(path.join(env.appRoot, 'payload', 'optiscaler', 'OptiScaler.dll'), 'OPTISCALER PROXY DLL v2');
    fs.appendFileSync(path.join(env.gameDir, 'OptiScaler.ini'), '[Menu]\r\nScale=1.2\r\n');
    const manifest = install.apply(install.plan(env.target, { appRoot: env.appRoot }), { logFile: env.logFile, appRoot: env.appRoot });
    assert.strictEqual(fs.readFileSync(path.join(env.gameDir, 'dxgi.dll'), 'utf8'), 'OPTISCALER PROXY DLL v2');
    const carried = manifest.records.find(r => r.target === installedOldOnly);
    assert.ok(carried && carried.carriedFrom, 'the dropped file is still on the books');

    const outcome = install.restore(env.gameDir);
    assert.deepStrictEqual(outcome.failures, []);
    assert.ok(!fs.existsSync(installedOldOnly), 'the file only the old release shipped is gone');
    const after = fs.readdirSync(env.gameDir).filter(n => n !== '.dlss5-aio').sort();
    assert.deepStrictEqual(after, before, 'the game folder is exactly what it was');
  } finally { env.cleanup(); }
});

test('an OptiScaler someone put in by hand is replaced under its own name, never doubled', () => {
  const env = scaffold();
  try {
    // what a real build carries in its version resource, as the installer looks for it
    const fakeBuild = Buffer.concat([Buffer.from('MZ someone else\'s OptiScaler build '),
      Buffer.from('OriginalFilename', 'utf16le'), Buffer.from([0, 0]), Buffer.from('OptiScaler.dll', 'utf16le'), Buffer.from([0, 0])]);
    fs.writeFileSync(path.join(env.gameDir, 'winmm.dll'), fakeBuild);
    const planned = install.plan(env.target, { appRoot: env.appRoot });
    const proxies = planned.files.filter(f => /OptiScaler neural rendering/.test(f.role)).map(f => path.basename(f.to));
    assert.deepStrictEqual(proxies, ['winmm.dll'], 'replaces the one already loading, adds no dxgi.dll');
    assert.ok(planned.notes.some(n => /already loading here as winmm\.dll/.test(n)), planned.notes.join('\n'));
    install.apply(planned, { logFile: env.logFile, appRoot: env.appRoot });
    assert.ok(!fs.existsSync(path.join(env.gameDir, 'dxgi.dll')));
    install.restore(env.gameDir);
    assert.deepStrictEqual(fs.readFileSync(path.join(env.gameDir, 'winmm.dll')), fakeBuild, 'their build came back byte for byte');
  } finally { env.cleanup(); }
});

test('the shipped OptiScaler payload is recognised as an OptiScaler build', { skip: !fs.existsSync(path.join(__dirname, '..', 'payload', 'optiscaler', 'OptiScaler.dll')) }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-opti-real-'));
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'payload', 'optiscaler', 'OptiScaler.dll'), path.join(root, 'dbghelp.dll'));
    fs.writeFileSync(path.join(root, 'dxgi.dll'), 'MZ some other loader');
    assert.strictEqual(install.existingOptiScalerProxy(root), 'dbghelp.dll');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
