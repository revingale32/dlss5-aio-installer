// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const media = require('../core/media');
const mediarun = require('../core/mediarun');

// Pictures, videos and desktop mode. The worker itself needs an NVIDIA GPU;
// everything around it - what counts as a picture, where results go, which
// settings are allowed, the exact command line and reading its progress
// stream - is tested here.

test('pictures and videos are told apart by extension, case-insensitively', () => {
  assert.strictEqual(media.classify('C:\\Shots\\a.PNG'), 'image');
  assert.strictEqual(media.classify('C:\\Shots\\b.jpeg'), 'image');
  assert.strictEqual(media.classify('C:\\Shots\\c.HEIC'), 'image');
  assert.strictEqual(media.classify('C:\\Clips\\d.mp4'), 'video');
  assert.strictEqual(media.classify('C:\\Clips\\e.MKV'), 'video');
  assert.strictEqual(media.classify('C:\\Clips\\f.txt'), null);
  assert.strictEqual(media.classify('C:\\Clips\\noext'), null);
  assert.strictEqual(media.classify(null), null);
});

test('settings are clamped to what the runtime accepts, unknown keys and bad values fall back', () => {
  const s = media.normalize({
    style: 7, intensity: 3, tone: -1, structure: '1.5', skin: 5, autoMask: 'yes', passes: 9, mix: -0.2,
    maxWorkMP: 999, codec: 'vp9', quality: 'ultra', audio: 'mp3', stabilize: 2, fpsCap: 1000, suffix: 'a<b>:c',
    evil: 'drop me',
  });
  assert.strictEqual(s.style, 2);
  assert.strictEqual(s.intensity, 1);
  assert.strictEqual(s.tone, 0);
  assert.strictEqual(s.structure, 1.5);
  assert.strictEqual(s.skin, 0.99);
  assert.strictEqual(s.autoMask, true);
  assert.strictEqual(s.passes, 3);
  assert.strictEqual(s.mix, 0);
  assert.strictEqual(s.maxWorkMP, 268);
  assert.strictEqual(s.codec, 'h264');
  assert.strictEqual(s.quality, 'high');
  assert.strictEqual(s.audio, 'copy');
  assert.strictEqual(s.stabilize, 1);
  assert.strictEqual(s.fpsCap, 480);
  assert.strictEqual(s.suffix, 'abc');
  assert.ok(!('evil' in s));
});

test('the defaults are the conservative ones', () => {
  const s = media.normalize({});
  assert.deepStrictEqual(
    { style: s.style, intensity: s.intensity, passes: s.passes, mix: s.mix, motionToNr: s.motionToNr, skin: s.skin, fpsCap: s.fpsCap },
    { style: 0, intensity: 1, passes: 1, mix: 1, motionToNr: false, skin: -1, fpsCap: 60 });
  assert.strictEqual(media.normalize(null).suffix, '_dlss5');
  assert.strictEqual(media.normalize({ skin: -0.5 }).skin, -1, 'any negative skin value means "follow structure"');
});

test('results go beside the original with a suffix and never over an existing file or the original', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-out-'));
  const input = path.join(dir, 'shot.jpg');
  fs.writeFileSync(input, 'x');
  const first = media.outputPathFor(input, 'image', {});
  assert.strictEqual(first, path.join(dir, 'shot_dlss5.png'), 'PNG by default - lossless');
  fs.writeFileSync(first, 'already here');
  const second = media.outputPathFor(input, 'image', {});
  assert.strictEqual(second, path.join(dir, 'shot_dlss5 (2).png'));
  assert.strictEqual(media.outputPathFor(input, 'image', { imageFormat: 'keep' }), path.join(dir, 'shot_dlss5.jpg'));
  assert.strictEqual(media.outputPathFor(path.join(dir, 'clip.mov'), 'video', {}), path.join(dir, 'clip_dlss5.mp4'));
  // With an empty suffix next to the original, the original's own name is skipped.
  const same = media.outputPathFor(path.join(dir, 'pic.png'), 'image', { suffix: '', outputDir: dir });
  assert.strictEqual(same, path.join(dir, 'pic (2).png'));
});

test('two inputs with the same name in one job get different outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-taken-'));
  const outDir = path.join(dir, 'out');
  const taken = new Set();
  const a = media.outputPathFor(path.join(dir, 'a', 'x.png'), 'image', { outputDir: outDir }, taken, () => false);
  const b = media.outputPathFor(path.join(dir, 'b', 'x.png'), 'image', { outputDir: outDir }, taken, () => false);
  assert.strictEqual(a, path.join(outDir, 'x_dlss5.png'));
  assert.strictEqual(b, path.join(outDir, 'x_dlss5 (2).png'));
});

test('the command line carries every setting, formatted, and nothing else', () => {
  const args = media.buildArgs('video', { style: 1, intensity: 0.5, passes: 2, mix: 0.75, stabilize: 0.4, codec: 'hevc', skin: -1 },
    { nr: 'C:\\rt\\nvngx_dlssnr.dll', bridge: 'C:\\app\\payload\\nvngx.dll', list: 'C:\\data\\job-1.txt', log: 'C:\\data\\m.log' });
  const value = flag => args[args.indexOf(flag) + 1];
  assert.strictEqual(value('--mode'), 'video');
  assert.strictEqual(value('--nr'), 'C:\\rt\\nvngx_dlssnr.dll');
  assert.strictEqual(value('--bridge'), 'C:\\app\\payload\\nvngx.dll');
  assert.strictEqual(value('--style'), '1');
  assert.strictEqual(value('--intensity'), '0.5');
  assert.strictEqual(value('--passes'), '2');
  assert.strictEqual(value('--mix'), '0.75');
  assert.strictEqual(value('--skin'), '-1');
  assert.strictEqual(value('--codec'), 'hevc');
  assert.strictEqual(value('--stabilize'), '0.4');
  assert.strictEqual(value('--list'), 'C:\\data\\job-1.txt');
  assert.ok(!args.includes('--monitor'), 'desktop-only flags stay out of a video job');
  assert.ok(!args.includes('--refine'), 'picture-only flags stay out of a video job');
  const desktop = media.buildArgs('desktop', { monitor: 1, fpsCap: 30 }, { nr: 'n', bridge: 'b' });
  assert.strictEqual(desktop[desktop.indexOf('--monitor') + 1], '1');
  assert.strictEqual(desktop[desktop.indexOf('--fps-cap') + 1], '30');
  assert.strictEqual(desktop[desktop.indexOf('--split') + 1], '0', 'split is off unless asked for');
  const split = media.buildArgs('desktop', { split: true }, { nr: 'n', bridge: 'b' });
  assert.strictEqual(split[split.indexOf('--split') + 1], '1');
  assert.ok(!desktop.includes('--list'));
  assert.deepStrictEqual(media.buildArgs('monitors', {}), ['--mode', 'monitors']);
  assert.throws(() => media.buildArgs('image', {}, { nr: 'n', bridge: 'b' }), /job list/);
  assert.throws(() => media.buildArgs('probe', {}, {}), /runtime and bridge/);
  assert.throws(() => media.buildArgs('rm -rf', {}, { nr: 'n', bridge: 'b' }), /Unknown mode/);
});

test('the job list is UTF-8, one tab-separated pair per line, and refuses unusable paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-list-'));
  const file = media.writeList(path.join(dir, 'job.txt'), [
    { input: 'C:\\Fotos\\Überblick.jpg', output: 'C:\\Fotos\\Überblick_dlss5.png' },
    { input: 'C:\\Clips\\a.mp4', output: 'C:\\Clips\\a_dlss5.mp4' },
  ]);
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(text, 'C:\\Fotos\\Überblick.jpg\tC:\\Fotos\\Überblick_dlss5.png\nC:\\Clips\\a.mp4\tC:\\Clips\\a_dlss5.mp4\n');
  assert.throws(() => media.writeList(path.join(dir, 'bad.txt'), [{ input: 'a\tb', output: 'c' }]), /Unusable path/);
  assert.throws(() => media.writeList(path.join(dir, 'bad.txt'), [{ input: 'a', output: '' }]), /Unusable path/);
});

test('progress lines are parsed, noise is not', () => {
  assert.deepStrictEqual(media.parseLine('{"event":"progress","frame":3}'), { event: 'progress', frame: 3 });
  assert.strictEqual(media.parseLine('warning: something'), null);
  assert.strictEqual(media.parseLine('{"no":"event"}'), null);
  assert.strictEqual(media.parseLine('{broken'), null);
  assert.strictEqual(media.parseLine('[1,2]'), null);
  const lines = [];
  const rest = media.splitLines('{"event":"a"}\n{"event":"b"}\n{"eve', line => lines.push(line));
  assert.deepStrictEqual(lines, ['{"event":"a"}', '{"event":"b"}']);
  assert.strictEqual(rest, '{"eve');
});

test('the runtime gate is the same one installs use', () => {
  const located = { nr: { file: 'C:\\rt\\nvngx_dlssnr.dll', from: 'C:\\rt', plausible: true } };
  const known = { details: { nr: { sha: 'e16bcf15', known: true, version: '310.8.0.0' } } };
  const unknown = { details: { nr: { sha: 'deadbeefcafe0000', known: false, version: '310.8.0.0' } } };
  assert.strictEqual(media.resolveRuntime(located, known).ok, true);
  assert.strictEqual(media.resolveRuntime(located, known).nr, 'C:\\rt\\nvngx_dlssnr.dll');
  const refused = media.resolveRuntime(located, unknown);
  assert.strictEqual(refused.ok, false);
  assert.match(refused.message, /not a validated copy/);
  assert.strictEqual(media.resolveRuntime(located, unknown, { allowUnknownNeural: true }).ok, true);
  assert.strictEqual(media.resolveRuntime({ nr: null }, null).ok, false);
  assert.strictEqual(media.resolveRuntime({ nr: { ...located.nr, plausible: false } }, known).ok, false);
});

test('the worker lives in its own folder, apart from the caller bridge', () => {
  // NVIDIA's own NGX loader looks for nvngx.dll beside the running exe first;
  // the worker must never sit next to our bridge of that name.
  const root = 'C:\\Program Files\\AIO';
  assert.notStrictEqual(path.dirname(media.workerPath(root)), path.dirname(media.bridgePath(root)));
  assert.strictEqual(path.basename(media.bridgePath(root)), 'nvngx.dll');
});

test('inside the installed app the worker and bridge are started from app.asar.unpacked', () => {
  // A process cannot be started from inside the asar archive, and the worker
  // LoadLibrary()s the bridge by path - both need the real, unpacked files.
  const packaged = 'C:\\Users\\r\\AppData\\Local\\Programs\\dlss-5-aio-installer\\resources\\app.asar\\payload\\nvngx.dll';
  assert.strictEqual(media.unpacked(packaged),
    'C:\\Users\\r\\AppData\\Local\\Programs\\dlss-5-aio-installer\\resources\\app.asar.unpacked\\payload\\nvngx.dll');
  assert.strictEqual(media.unpacked(media.unpacked(packaged)), media.unpacked(packaged), 'applying it twice changes nothing');
  assert.strictEqual(media.unpacked('C:\\dev\\aio\\payload\\nvngx.dll'), 'C:\\dev\\aio\\payload\\nvngx.dll', 'a source checkout is left alone');
  assert.match(media.workerPath(path.join('C:', 'x', 'resources', 'app.asar')), /app\.asar\.unpacked/);
  assert.match(media.bridgePath(path.join('C:', 'x', 'resources', 'app.asar')), /app\.asar\.unpacked/);
});

// ---------------------------------------------------------------- the runner

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.written = [];
  child.stdin = { destroyed: false, on: () => {}, write: text => child.written.push(text), end: () => { child.stdin.destroyed = true; } };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('the runner turns stdout into events, split across chunks, and reports the exit', () => {
  const child = fakeChild();
  const events = [];
  const runner = mediarun.createRunner({ spawn: () => child, onEvent: event => events.push(event) });
  assert.strictEqual(runner.start('job', 'worker.exe', ['--mode', 'image'], { id: 7, mode: 'image' }).ok, true);
  child.stdout.emit('data', '{"event":"file-start","index":0}\n{"event":"file-do');
  child.stdout.emit('data', 'ne","index":0,"output":"x.png"}\nnot json\n');
  child.emit('exit', 0, null);
  assert.deepStrictEqual(events.map(event => event.event), ['file-start', 'file-done', 'exit']);
  assert.strictEqual(events[1].job, 7);
  assert.strictEqual(events[1].slot, 'job');
  assert.strictEqual(events[2].ok, true);
  assert.strictEqual(runner.isRunning('job'), false);
});

test('live desktop commands: the look and the split go to a running worker as single lines', () => {
  assert.strictEqual(media.lookCommand({ style: 2, passes: 3, mix: 0.5 }),
    'look style=2 passes=3 intensity=1 tone=1 structure=1 skin=-1 automask=1 mix=0.5 stabilize=0.6 work=8.3 fps=60');
  assert.match(media.lookCommand({ maxWorkMP: 0, fpsCap: 0 }), / work=0 fps=0$/, 'full size and uncapped go through as 0');
  assert.match(media.lookCommand({ style: 9, passes: 0, mix: 7 }), /^look style=2 passes=1 .* mix=1 /, 'values are clamped like everywhere else');
  assert.strictEqual(media.splitCommand(true), 'split 1');
  assert.strictEqual(media.splitCommand(false), 'split 0');

  const child = fakeChild();
  const runner = mediarun.createRunner({ spawn: () => child });
  assert.strictEqual(runner.command('desktop', 'split 1'), false, 'nothing running, nothing sent');
  runner.start('desktop', 'w', [], {});
  assert.strictEqual(runner.command('desktop', media.lookCommand({ style: 1 })), true);
  assert.strictEqual(runner.command('desktop', 'split 1'), true);
  assert.deepStrictEqual(child.written, [`${media.lookCommand({ style: 1 })}\n`, 'split 1\n']);
  assert.throws(() => runner.command('desktop', 'look\nstop'), /one line/);
  child.emit('exit', 0, null);
  assert.strictEqual(runner.command('desktop', 'split 0'), false, 'an exited worker gets nothing');
});

test('one job and one desktop session at a time, and they can run together', () => {
  const runner = mediarun.createRunner({ spawn: () => fakeChild() });
  assert.strictEqual(runner.start('job', 'w', [], {}).ok, true);
  assert.strictEqual(runner.start('job', 'w', [], {}).ok, false);
  assert.strictEqual(runner.start('desktop', 'w', [], {}).ok, true);
  assert.strictEqual(runner.start('desktop', 'w', [], {}).ok, false);
  assert.throws(() => runner.start('other', 'w', [], {}), /Unknown slot/);
});

test('stopping asks politely on stdin and only kills after the grace period', () => {
  const child = fakeChild();
  let pending = null;
  const runner = mediarun.createRunner({ spawn: () => child, setTimer: fn => { pending = fn; return 1; }, clearTimer: () => { pending = null; } });
  runner.start('desktop', 'w', [], {});
  runner.stop('desktop');
  assert.deepStrictEqual(child.written, ['stop\n']);
  assert.strictEqual(child.killed, false);
  pending();
  assert.strictEqual(child.killed, true, 'a worker that ignores the request is ended');

  const polite = fakeChild();
  let timer = null;
  const second = mediarun.createRunner({ spawn: () => polite, setTimer: fn => { timer = fn; return 2; }, clearTimer: () => { timer = null; } });
  second.start('job', 'w', [], {});
  second.stop('job');
  assert.deepStrictEqual(polite.written, ['cancel\n']);
  polite.emit('exit', 1, null);
  assert.strictEqual(timer, null, 'a worker that stops in time is never killed');
});

test('a worker that cannot start is an error, not a crash', () => {
  const runner = mediarun.createRunner({ spawn: () => { throw new Error('ENOENT'); } });
  const result = runner.start('job', 'missing.exe', [], {});
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /could not start/);
});

test('runOnce collects every event and survives a worker that never answers', async () => {
  const child = fakeChild();
  const done = mediarun.runOnce(() => child, 'w', [], { timeoutMs: 1000 });
  child.stdout.emit('data', '{"event":"monitor","index":0}\n{"event":"monitors","count":1}');
  child.emit('exit', 0);
  const result = await done;
  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(result.events.map(event => event.event), ['monitor', 'monitors']);

  const silent = fakeChild();
  const timedOut = await mediarun.runOnce(() => silent, 'w', [], { timeoutMs: 30 });
  assert.strictEqual(timedOut.code, -2);
  assert.strictEqual(silent.killed, true);
});

test('main wires every media channel through the tested core', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const channel of ['media:start', 'media:cancel', 'media:probe', 'media:monitors', 'media:preview', 'desktop:start', 'desktop:stop']) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\('${channel}'`));
  }
  assert.match(mainSource, /media\.buildArgs\(/);
  assert.match(mainSource, /isAllowedMedia\(/, 'main only acts on files the user chose or a job wrote');
  assert.match(mainSource, /registerSchemesAsPrivileged/);
  assert.doesNotMatch(mainSource, /shell:\s*true/, 'the worker is never started through a shell');
});
