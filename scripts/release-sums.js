// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// After a build: hash everything a release ships and write SHA256SUMS.txt next
// to it, plus what to paste into the release notes. The scene this app lives
// in has lookalike repos and tampered zips (2026-09); a published hash is the
// one thing a user can check without trusting the download page.
//
//   node scripts/release-sums.js            hashes dist-installer/*.exe and the payload
//   node scripts/release-sums.js <dir>      a different output folder

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist-installer'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function main() {
  if (!fs.existsSync(OUT)) { console.error(`No build output at ${OUT}. Run the build first.`); return 1; }
  // The Setup and latest.yml: the app's updater reads latest.yml from the newest
  // GitHub release, so a release without it is invisible to installed copies.
  const artifacts = fs.readdirSync(OUT).filter(name => /\.exe$/i.test(name) || name === 'latest.yml').map(name => path.join(OUT, name));
  const payload = ['standalone-dlssnr.addon64', 'nvngx.dll', 'ReShade64.dll', 'ReShade32.dll', 'media/dlss5-media.exe']
    .map(name => path.join(ROOT, 'payload', name)).filter(file => fs.existsSync(file));
  if (!artifacts.length) { console.error(`No .exe in ${OUT}.`); return 1; }
  const lines = [];
  const notes = [`DLSS 5 AIO Installer ${pkg.version} - add-on ${/\d+\.\d+\.\d+-revin\d+/.exec(pkg.description)?.[0] || ''}`.trim(), '', 'SHA-256:'];
  for (const file of [...artifacts, ...payload]) {
    const sum = sha256(file);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    lines.push(`${sum}  ${rel}`);
    notes.push(`  ${path.basename(file).padEnd(44)} ${sum}`);
  }
  notes.push('', 'Made by Revin (revingale32). Official download: https://github.com/revingale32/dlss5-aio-installer/releases',
    'Not affiliated with NVIDIA. NVIDIA and DLSS are trademarks of NVIDIA Corporation.');
  notes.push('', 'No NVIDIA runtime DLLs are inside. Verify on Windows with:  certutil -hashfile "<file>" SHA256',
    'VirusTotal: upload each .exe and paste the permalink here before publishing.');
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'RELEASE-NOTES-hashes.txt'), notes.join('\n') + '\n');
  console.log(notes.join('\n'));
  console.log(`\nwritten: ${path.join(OUT, 'SHA256SUMS.txt')}`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { sha256, main };
