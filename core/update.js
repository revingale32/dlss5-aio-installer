// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// Updates from the app's own GitHub releases. electron-updater does the work
// (it reads latest.yml from the newest release, downloads the Setup and checks
// its SHA-512 before anything runs); this module decides what the app says and
// offers at each step, so the wording and the rules are tested without Electron.
//
// Consent first: nothing asks GitHub anything until the user has said yes
// (asked once, changeable in Settings) or presses "Check for updates" themselves.

const OFFICIAL = 'github.com/revingale32/dlss5-aio-installer';

// checkUpdates: null = never asked, true = check when the app starts, false = don't.
function checkOnStart(settings) {
  return Boolean(settings) && settings.checkUpdates === true;
}

// One short line from whatever electron-updater threw: no stack, no request
// dump, no endless URL. Offline and "nothing published yet" get plain words.
function errorText(error) {
  const raw = String((error && (error.message || error)) || 'unknown error');
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION/i.test(raw)) {
    return 'GitHub could not be reached - check the internet connection.';
  }
  if (/latest\.yml|HttpError: 404|status 404|Unable to find latest version|No published versions/i.test(raw)) {
    return 'No update information was found on the official releases page yet.';
  }
  const first = raw.split(/\r?\n/)[0].trim();
  return first.length > 180 ? `${first.slice(0, 177)}...` : first;
}

// What the bar at the top of the window says, and which buttons it shows.
//   state:   { state: 'idle'|'checking'|'none'|'available'|'downloading'|'downloaded'|'error', version, percent, during, message }
//   consent: settings.checkUpdates (null | true | false)
//   enabled: false in a copy run from source - it has no update feed.
//   dismissed: the user pressed "Later" on this state.
// actions: 'allow' | 'deny' | 'download' | 'notes' | 'later' | 'restart'
function bar({ state, consent, enabled, current, dismissed } = {}) {
  const s = state || { state: 'idle' };
  if (!enabled) return { message: '', actions: [] };
  if (consent === null || consent === undefined) {
    if (dismissed) return { message: '', actions: [] };
    return {
      message: 'Look for new versions of this app? When it starts it would ask its official GitHub page '
        + `(${OFFICIAL}) for the newest version number, and offer the update when there is one. `
        + 'Nothing else is sent. You can change this any time in Settings.',
      actions: ['allow', 'deny'],
    };
  }
  switch (s.state) {
    case 'available':
      if (dismissed) return { message: '', actions: [] };
      return {
        message: `Version ${s.version} is available - you have ${current}. It installs over this one and keeps your settings, games and profiles.`,
        actions: ['download', 'notes', 'later'],
      };
    case 'downloading':
      return {
        message: `Downloading version ${s.version}${Number.isFinite(s.percent) ? ` - ${Math.max(0, Math.min(100, Math.round(s.percent)))}%` : ''}...`,
        actions: [],
      };
    case 'downloaded':
      if (dismissed) return { message: '', actions: [] };
      return {
        message: `Version ${s.version} is downloaded and checked. Restart the app to finish - it takes a few seconds.`,
        actions: ['restart', 'later'],
      };
    case 'error':
      if (s.during !== 'download' || dismissed) return { message: '', actions: [] };
      return { message: `The update could not be downloaded: ${s.message}`, actions: ['download', 'later'] };
    default:
      return { message: '', actions: [] };
  }
}

// The one line under "Check for updates" on the About page.
function status({ state, consent, enabled, current } = {}) {
  const s = state || { state: 'idle' };
  if (!enabled) return 'Updates come from the installed app - a copy run from its source folder does not check.';
  switch (s.state) {
    case 'checking': return 'Asking GitHub for the newest version...';
    case 'none': return `This is the newest version (${current}).`;
    case 'available': return `Version ${s.version} is available - you have ${current}.`;
    case 'downloading': return `Downloading version ${s.version}...`;
    case 'downloaded': return `Version ${s.version} is ready - restart the app to finish.`;
    case 'error': return `Could not check for updates: ${s.message}`;
    default:
      if (consent === true) return 'Checks for new versions when the app starts.';
      if (consent === false) return 'Automatic checks are off - this button still works.';
      return 'Not checked yet.';
  }
}

module.exports = { OFFICIAL, checkOnStart, errorText, bar, status };
