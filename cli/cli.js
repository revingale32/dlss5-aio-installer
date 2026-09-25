// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');
const scan = require('../core/scan');
const install = require('../core/install');
const runtimes = require('../core/runtimes');
const authenticode = require('../core/authenticode');
const anticheat = require('../core/anticheat');
const logreport = require('../core/logreport');

const APP_ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const positional = [];
  const flags = Object.create(null);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split('=');
    if (inline !== undefined) { flags[name] = inline; continue; }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { flags[name] = next; index++; } else flags[name] = true;
  }
  return { positional, flags };
}

function bytes(value) {
  if (!value) return '';
  const mb = value / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(0)} MB` : `${(value / 1024).toFixed(0)} KB`;
}

function describeTarget(game) {
  const { chosen, candidates } = scan.chooseExecutable(game.dir);
  const cheat = anticheat.detect(game.dir);
  const state = install.status(game.dir);
  return { ...game, exe: chosen, candidates, anticheat: cheat, installed: state.installed, managed: state.managed,
    route: state.route || install.routeFor(chosen), build: state.build };
}

// ---------------------------------------------------------------- commands

const commands = {
  scan({ flags }) {
    const games = scan.scanAll();
    if (!games.length) {
      console.log('No games found. Steam and Xbox Game Pass folders were checked; use --dir to point at one.');
      return 0;
    }
    console.log(`${games.length} game${games.length === 1 ? '' : 's'} found\n`);
    for (const game of games) {
      const detail = flags.quick ? game : describeTarget(game);
      const marks = [];
      if (detail.installed) marks.push(detail.managed ? `INSTALLED ${detail.build || ''}`.trim() : `FOUND ${detail.build || ''}`.trim());
      if (detail.route === 'relay') marks.push('RELAY');
      if (detail.route === 'optiscaler') marks.push('OPTISCALER');
      if (detail.anticheat && detail.anticheat.present) marks.push(detail.anticheat.systems.join('+'));
      if (detail.exe && detail.exe.bitness === 32) marks.push('32-bit');
      const exe = detail.exe ? `${detail.exe.name} (${detail.exe.api}, ${detail.exe.bitness}-bit)` : 'no executable found';
      console.log(`  ${game.store.padEnd(5)} ${game.name}`);
      console.log(`        ${exe}${marks.length ? '   [' + marks.join(', ') + ']' : ''}`);
      if (flags.verbose) console.log(`        ${game.dir}`);
    }
    return 0;
  },

  runtimes() {
    const found = runtimes.locate({ appRoot: APP_ROOT, games: scan.scanAll() });
    for (const entry of found.searched) {
      console.log(`  ${entry.found.length ? '+' : ' '} ${entry.dir}${entry.found.length ? '  -> ' + entry.found.join(', ') : ''}`);
    }
    console.log('');
    for (const [kind, file] of Object.entries(runtimes.WANTED)) {
      const hit = found[kind];
      console.log(`  ${file.padEnd(22)} ${hit ? `${bytes(hit.bytes)}  ${hit.from}` : 'not found'}`);
    }
    const state = runtimes.describe(found);
    console.log(`\n  ${state.ok ? 'OK' : 'PROBLEM'}: ${state.message}`);
    if (state.ok) {
      // Are they the exact files this build was validated with, and who signed them?
      const check = runtimes.verify(found, { allowUnknownNeural: true });
      console.log('');
      for (const [kind, file] of Object.entries(runtimes.WANTED)) {
        const detail = check.details[kind];
        if (!detail) continue;
        const sig = authenticode.describe(authenticode.signature(found[kind].file));
        console.log(`  ${file.padEnd(22)} ${(detail.version || 'version ?').padEnd(11)} sha256 ${detail.sha.slice(0, 16)}…  `
          + `${detail.known ? 'known-good' : 'NOT VALIDATED'}  ·  ${sig.text}`);
      }
      const unknownNeural = check.details.nr && !check.details.nr.known;
      if (unknownNeural) console.log('\n  PROBLEM: the neural runtime is not a validated copy; installs are refused unless --allow-unknown-runtime is given.');
      for (const note of check.notes.filter(n => !/^Allowed by your setting/.test(n))) console.log(`\n  note: ${note}`);
    }

    // This PC against what the runtimes need, read off the files themselves.
    const readiness = install.inspectMachine({
      nr: found.nr ? found.nr.file : null, sr: found.sr ? found.sr.file : null, fg: found.fg ? found.fg.file : null,
    });
    console.log('');
    console.log(`  GPU      ${readiness.gpu.available ? `${readiness.gpu.name} - ${readiness.gpu.architectureName || 'generation unknown'}` : 'not detected'}`
      + `${readiness.gpu.driver ? `  (driver ${readiness.gpu.driver})` : ''}`);
    console.log(`  HAGS     ${readiness.hags.available ? readiness.hags.state : 'n/a'}`);
    for (const [kind, file] of Object.entries(runtimes.WANTED)) {
      const info = readiness.runtimes[kind];
      const verdict = readiness.verdicts[kind];
      if (!info) continue;
      const mark = verdict && verdict.ok === true ? 'ok ' : verdict && verdict.ok === false ? 'NO ' : '?  ';
      console.log(`  ${mark}${file.padEnd(20)} ${info.fileVersion || '?'}  needs ${info.minArchitectureName || 'unknown'}`);
    }
    for (const line of readiness.problems) console.log(`\n  PROBLEM: ${line}`);
    for (const line of readiness.notes) console.log(`\n  note: ${line}`);
    return state.ok && readiness.problems.length === 0 ? 0 : 1;
  },

  plan({ positional, flags }) {
    const target = targetFrom(positional[0], flags);
    if (!target) return 1;
    const planned = install.plan(target, { appRoot: APP_ROOT, profile: profileFrom(flags), allowUnknownNeural: flags['allow-unknown-runtime'] === true });
    printPlan(planned);
    return planned.installable ? 0 : 1;
  },

  install({ positional, flags }) {
    const target = targetFrom(positional[0], flags);
    if (!target) return 1;
    const planned = install.plan(target, { appRoot: APP_ROOT, profile: profileFrom(flags), allowUnknownNeural: flags['allow-unknown-runtime'] === true });
    printPlan(planned);
    if (!planned.installable) return 1;
    if (flags['dry-run']) { console.log('\n(dry run: nothing was written)'); return 0; }
    try {
      const manifest = install.apply(planned, { appRoot: APP_ROOT, acknowledgedAntiCheat: flags['accept-anticheat'] === true });
      console.log(`\nInstalled build ${manifest.build}. ${manifest.files.length} file(s) placed, originals backed up.`);
      console.log(`Restore any time with:  npm run cli -- restore "${target.dir}"`);
      return 0;
    } catch (error) {
      if (error.code === 'ANTICHEAT_CONSENT_REQUIRED') {
        console.error('\n' + error.warning);
        console.error('\nRefused. Re-run with --accept-anticheat if you understand and accept that risk.');
        return 2;
      }
      console.error(`\nInstall failed: ${error.message}`);
      if (error.rollbackFailures && error.rollbackFailures.length) {
        console.error('Some files could not be rolled back:');
        for (const failure of error.rollbackFailures) console.error(`  ${failure.target}: ${failure.error}`);
      } else {
        console.error('Every file was put back.');
      }
      return 1;
    }
  },

  restore({ positional, flags }) {
    const dir = positional[0];
    if (!dir) { console.error('Usage: restore <game folder> [--force]'); return 1; }
    const result = install.restore(dir, { force: flags.force === true });
    console.log(`${result.restored.length} original(s) restored, ${result.removed.length} added file(s) removed`
      + `${result.skipped && result.skipped.length ? `, ${result.skipped.length} left alone (changed since the install; --force overrides)` : ''}.`);
    for (const failure of result.failures) console.error(`  ! ${failure}`);
    return result.failures.length ? 1 : 0;
  },

  verify({ positional }) {
    const dir = positional[0];
    if (!dir) { console.error('Usage: verify <game folder>'); return 1; }
    const check = install.verify(dir);
    if (!check.installed) { console.log('Nothing is installed here by this app.'); return 0; }
    console.log(`  checked:  ${check.checked} file(s)`);
    for (const file of check.intact) console.log(`  intact    ${file}`);
    for (const file of check.changed) console.log(`  CHANGED   ${file}`);
    for (const file of check.missing) console.log(`  MISSING   ${file}`);
    for (const file of check.unknown) console.log(`  unknown   ${file}  (installed before hashes were recorded)`);
    for (const file of check.settings || []) console.log(`  settings  ${file}  (the game's overlay rewrites it; not checked)`);
    if (check.summary) console.log(`\n  ${check.summary}`);
    else console.log('\n  Everything this app installed is still exactly as installed.');
    return check.gameUpdated ? 1 : 0;
  },

  status({ positional }) {
    const dir = positional[0];
    if (!dir) { console.error('Usage: status <game folder>'); return 1; }
    const manifest = install.readManifest(dir);
    if (!manifest) { console.log('Nothing was installed here by this app.'); return 0; }
    console.log(`  installed: ${manifest.installed}`);
    console.log(`  build:     ${manifest.build}`);
    console.log(`  when:      ${manifest.installedAt}`);
    console.log(`  hook:      ${manifest.hook}`);
    if (manifest.antiCheat && manifest.antiCheat.length) console.log(`  anti-cheat: ${manifest.antiCheat.join(', ')}`);
    for (const entry of manifest.files || []) console.log(`  file:      ${entry.to}`);
    const past = install.history(dir);
    if (past.length) console.log(`  history:   ${past.map(e => e.action).join(' -> ')}`);
    return 0;
  },

  log({ positional }) {
    const file = positional[0] || logreport.defaultLogFile();
    if (!file || !fs.existsSync(file)) { console.error(`No log at ${file || '(unknown)'}`); return 1; }
    console.log(logreport.format(logreport.read(file)));
    return 0;
  },

  help() {
    console.log(`DLSS 5 AIO Installer - command line

  scan [--verbose] [--quick]   list Steam and Xbox games, with the executable and API detected
  runtimes                     where the NVIDIA runtime DLLs were found on this PC
  plan <folder> [--exe NAME]   what an install would do, without touching anything
  install <folder> [flags]     do it (--allow-unknown-runtime accepts an unvalidated nvngx_dlssnr.dll)
  restore <folder> [--force]   put the originals back and remove what we added; files a game update
                               changed since the install are left alone unless --force
  verify <folder>              check that what we installed is still on disk unchanged
  status <folder>              what is installed there
  log [file]                   read standalone-dlssnr.log and say what the numbers mean

install flags:
  --dry-run                    plan only
  --accept-anticheat           acknowledge the risk in a game that has anti-cheat
  --exe NAME                   choose a specific executable in the folder
  --passes N                   neural passes (1-3)
  --model N                    NR model
  --fg 0|1  --fg-multiplier N  frame generation
`);
    return 0;
  },
};

// ---------------------------------------------------------------- helpers

function targetFrom(dir, flags) {
  if (!dir) { console.error('Point at a game folder.'); return null; }
  if (!fs.existsSync(dir)) { console.error(`No such folder: ${dir}`); return null; }
  const { chosen, candidates } = scan.chooseExecutable(dir);
  let exe = chosen;
  if (flags.exe) {
    exe = candidates.find(entry => entry.name.toLowerCase() === String(flags.exe).toLowerCase());
    if (!exe) {
      console.error(`No executable called ${flags.exe} here. Found: ${candidates.map(c => c.name).join(', ') || 'none'}`);
      return null;
    }
  }
  return { dir, name: path.basename(dir), exe, candidates };
}

function profileFrom(flags) {
  const profile = {};
  if (flags.passes) profile.Passes = String(Math.max(1, Math.min(3, Number(flags.passes) || 2)));
  if (flags.model) profile.Model = String(flags.model);
  if (flags.fg !== undefined && flags.fg !== true) profile.FrameGeneration = flags.fg === '0' ? '0' : '1';
  if (flags['fg-multiplier']) profile.FrameGenMultiplier = String(flags['fg-multiplier']);
  return profile;
}

function printPlan(planned) {
  console.log(`  folder:     ${planned.gameDir}`);
  console.log(`  executable: ${planned.exe ? `${planned.exe.name} (${planned.exe.api}, ${planned.exe.bitness}-bit)` : 'none found'}`);
  console.log(`  hook as:    ${planned.hook}`);
  console.log(`  route:      ${planned.route === 'relay' ? 'neural relay (32-bit game)' : planned.route === 'optiscaler' ? 'OptiScaler (native ray reconstruction)' : 'in the game folder'}`);
  if (planned.alreadyInstalled) {
    console.log(planned.current && planned.current.managed
      ? `  note:       this app installed build ${planned.current.build} here; it will be replaced`
      : `  note:       a kit is already here (build ${(planned.current && planned.current.build) || 'unknown'}), not installed by this app; it will be replaced and backed up`);
  }
  console.log('  will place:');
  for (const file of planned.files) {
    console.log(`     ${file.action === 'park' ? `${file.from}  ->  ${file.to}` : file.to}${file.shared ? '   (machine-wide, shared)' : file.outsideGame ? '   (machine-wide)' : ''}`);
    console.log(`       ${file.role}`);
  }
  for (const edit of planned.iniEdits || []) {
    console.log(`     ${edit.file}   (settings)`);
    console.log(`       ${edit.role}`);
  }
  for (const note of planned.notes) console.log(`  note:       ${note}`);
  for (const problem of planned.problems) console.log(`  PROBLEM:    ${problem}`);
  if (planned.anticheat.present) {
    console.log('');
    console.log(anticheat.warning(planned.anticheat).split('\n').map(line => '  ' + line).join('\n'));
  }
}

// ---------------------------------------------------------------- entry

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const name = positional.shift() || 'help';
  const command = commands[name] || commands.help;
  try {
    return command({ positional, flags });
  } catch (error) {
    console.error(`${name} failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, parseArgs };
