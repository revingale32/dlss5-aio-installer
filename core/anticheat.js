// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');

// Anti-cheat detection.
//
// The rule this installer follows, in the owner's words: "isn't to refuse, it's
// to not bypass." Nothing here disables, patches, hides from or works around an
// anti-cheat. It looks for the markers, tells the truth about what will happen,
// and lets the person decide - except that the decision is theirs to make
// explicitly, every time, and consent is never remembered.

const MARKERS = [
  { id: 'EasyAntiCheat', dirs: ['EasyAntiCheat', 'EasyAntiCheat_EOS'], files: [/^start_protected_game\.exe$/i, /^EasyAntiCheat.*\.(exe|dll|sys)$/i] },
  { id: 'BattlEye', dirs: ['BattlEye', 'BattlEye_x64'], files: [/^BEService.*\.exe$/i, /_BE\.exe$/i, /^BEClient.*\.dll$/i] },
  { id: 'Denuvo Anti-Cheat', dirs: [], files: [/^denuvo.*\.(exe|dll|sys)$/i] },
  { id: 'Ricochet', dirs: [], files: [/^ricochet.*\.(exe|dll|sys)$/i] },
  { id: 'nProtect GameGuard', dirs: ['GameGuard'], files: [/^GameGuard.*\.(des|dll)$/i] },
  { id: 'Vanguard', dirs: [], files: [/^vgc\.exe$/i, /^vgk\.sys$/i] },
];

function detect(gameDir, { maxDepth = 2 } = {}) {
  const found = new Set();
  const evidence = [];
  let budget = 3000;

  (function walk(dir, depth) {
    if (depth > maxDepth || budget <= 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      for (const marker of MARKERS) {
        if (entry.isDirectory() && marker.dirs.some(d => d.toLowerCase() === entry.name.toLowerCase())) {
          found.add(marker.id);
          evidence.push(path.join(dir, entry.name));
        } else if (entry.isFile() && marker.files.some(pattern => pattern.test(entry.name))) {
          found.add(marker.id);
          evidence.push(path.join(dir, entry.name));
        }
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
    }
  })(gameDir, 0);

  return { present: found.size > 0, systems: [...found], evidence: evidence.slice(0, 12) };
}

// What the person is actually agreeing to, in plain words. The wording matters
// more than the mechanism: nobody should install this believing the kit will
// get them past something.
function warning(detection) {
  if (!detection.present) return null;
  const list = detection.systems.join(' + ');
  const lines = [
    `This folder has ${list}.`,
    '',
    'This installer never bypasses anti-cheat and never will. What it does is put an',
    'add-on-enabled build of ReShade next to the game, which is exactly the kind of',
    'injection anti-cheat is built to block.',
    '',
    'The likely outcomes are that the game refuses to start, or that it starts without',
    'the add-on loading. Some anti-cheat systems also flag a blocked injection attempt,',
    'not only actual cheating - "it is not a cheat" does not protect an account. That',
    'risk sits with you.',
    '',
    'If you want DLSS 5 in this game, use a build of it that has no anti-cheat in it.',
  ];
  if (detection.systems.includes('BattlEye')) {
    lines.push('',
      'BattlEye note: some games ship their own switch for it - GTA V Enhanced has the',
      '-nobattleye Steam launch option, which turns it off for Story Mode and locks you',
      'out of Online. That is the game\'s own switch, not a bypass.');
  }
  return lines.join('\n');
}

module.exports = { detect, warning, MARKERS };
