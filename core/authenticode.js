// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const { spawnSync } = require('child_process');

// Who signed a file, according to Windows itself. This is the second opinion
// next to the SHA-256 table in runtimes.js: the hash says "this is the exact
// file we validated", the signature says "NVIDIA signed whatever this is".
// Both are reported; only the hash decides. Off Windows there is no
// Authenticode and the answer is honestly "unavailable".
//
// Status values come straight from Get-AuthenticodeSignature: Valid, NotSigned,
// HashMismatch (the file was changed after signing), NotTrusted, UnknownError.

function signature(file, { timeoutMs = 15000, platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'win32') return { status: 'unavailable', signer: null, reason: 'not Windows' };
  const escaped = String(file).replace(/'/g, "''");
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${escaped}'; `
    + `[Console]::Out.Write(($s.Status.ToString()) + '|' + ($(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' })))`;
  let result;
  try {
    result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  } catch (error) {
    return { status: 'unavailable', signer: null, reason: error.message };
  }
  if (!result || result.error || result.status !== 0) {
    return { status: 'unavailable', signer: null, reason: (result && (result.error ? result.error.message : String(result.stderr || '').trim())) || 'powershell failed' };
  }
  const [status = '', subject = ''] = String(result.stdout || '').trim().split('|');
  const signer = /CN=([^,]+)/.exec(subject);
  return { status: status || 'UnknownError', signer: signer ? signer[1].trim() : (subject || null) };
}

function describe(sig) {
  switch (sig.status) {
    case 'Valid': return { tone: 'on', text: `signed by ${sig.signer || 'a trusted publisher'}` };
    case 'HashMismatch': return { tone: 'bad', text: 'signature does not match the file - it was modified after NVIDIA signed it' };
    case 'NotSigned': return { tone: 'warn', text: 'not signed' };
    case 'NotTrusted': return { tone: 'bad', text: `signed by an untrusted certificate${sig.signer ? ` (${sig.signer})` : ''}` };
    case 'unavailable': return { tone: 'off', text: `signature not checked (${sig.reason})` };
    default: return { tone: 'warn', text: `signature status ${sig.status}` };
  }
}

module.exports = { signature, describe };
