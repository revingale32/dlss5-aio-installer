// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The whole surface the page is allowed to touch. Nothing else crosses: no
// node, no fs, no ipcRenderer itself. Every name here must have a matching
// ipcMain.handle in main.js and every name the page calls must be here - there
// is a test that checks all three lists line up.

// Events pushed from the main process. The page gets a subscribe function and
// nothing else; the raw event object never reaches it.
function subscribe(channel) {
  return listener => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  };
}

const api = {
  listGames: () => ipcRenderer.invoke('library:list'),
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  // A File from a drop event. Its path is read here, in the preload, because
  // the page is not allowed to know paths on its own.
  addDroppedFile: file => ipcRenderer.invoke('library:addFolderPath', { file: webUtils.getPathForFile(file) }),
  forgetFolder: dir => ipcRenderer.invoke('library:forget', { dir }),

  planGame: (dir, exeName, profile) => ipcRenderer.invoke('game:plan', { dir, exeName, profile }),
  installGame: (dir, exeName, profile, acknowledgedAntiCheat) =>
    ipcRenderer.invoke('game:install', { dir, exeName, profile, acknowledgedAntiCheat }),
  restoreGame: (dir, force) => ipcRenderer.invoke('game:restore', { dir, force }),
  gameStatus: dir => ipcRenderer.invoke('game:status', { dir }),
  verifyGame: dir => ipcRenderer.invoke('game:verify', { dir }),

  locateRuntimes: () => ipcRenderer.invoke('runtimes:locate'),
  browseRuntimes: () => ipcRenderer.invoke('runtimes:browse'),
  forgetRuntimeDir: dir => ipcRenderer.invoke('runtimes:forget', { dir }),

  getCover: (game, kinds) => ipcRenderer.invoke('covers:get', { game, kinds }),
  readLog: file => ipcRenderer.invoke('log:read', { file }),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  listActivity: () => ipcRenderer.invoke('activity:list'),
  clearActivity: () => ipcRenderer.invoke('activity:clear'),
  copyText: text => ipcRenderer.invoke('clipboard:write', { text }),

  windowControl: action => ipcRenderer.invoke('window:control', { action }),
  openFolder: dir => ipcRenderer.invoke('shell:openFolder', { dir }),
  openLink: name => ipcRenderer.invoke('shell:openLink', { name }),
  // Updates from the official GitHub releases - only after the user says yes.
  updateGet: () => ipcRenderer.invoke('update:get'),
  updateConsent: allow => ipcRenderer.invoke('update:consent', { allow }),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // Pictures, videos and the live desktop. Dropped files cross as paths read
  // here in the preload; main only ever acts on files the user chose.
  mediaReadiness: () => ipcRenderer.invoke('media:readiness'),
  mediaGetSettings: () => ipcRenderer.invoke('media:getSettings'),
  mediaSetSettings: patch => ipcRenderer.invoke('media:setSettings', patch),
  mediaPickFiles: () => ipcRenderer.invoke('media:pickFiles'),
  mediaAddDropped: files => ipcRenderer.invoke('media:addPaths', { paths: [...files].map(file => webUtils.getPathForFile(file)) }),
  mediaPickOutputDir: () => ipcRenderer.invoke('media:pickOutputDir'),
  mediaStart: (mode, files, settings) => ipcRenderer.invoke('media:start', { mode, files, settings }),
  mediaCancel: () => ipcRenderer.invoke('media:cancel'),
  mediaProbe: settings => ipcRenderer.invoke('media:probe', { settings }),
  mediaMonitors: () => ipcRenderer.invoke('media:monitors'),
  mediaPreview: file => ipcRenderer.invoke('media:preview', { file }),
  mediaReveal: file => ipcRenderer.invoke('media:reveal', { file }),
  mediaOpen: file => ipcRenderer.invoke('media:open', { file }),
  desktopStart: settings => ipcRenderer.invoke('desktop:start', { settings }),
  desktopStop: () => ipcRenderer.invoke('desktop:stop'),
  desktopLook: settings => ipcRenderer.invoke('desktop:look', { settings }),
  desktopSplit: on => ipcRenderer.invoke('desktop:split', { on }),

  onActivity: subscribe('activity:entry'),
  onMediaEvent: subscribe('media:event'),
  onWindowState: subscribe('window:state'),
  onUpdate: subscribe('update:state'),
};

contextBridge.exposeInMainWorld('api', api);
module.exports = { api };     // for the surface test only; Electron ignores it
