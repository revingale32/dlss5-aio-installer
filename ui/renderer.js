// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// The page. Everything it knows comes through window.api (see preload.js);
// every decision is made by the same core the command line drives, so the two
// can never disagree about what an install does. Nothing here builds DOM from
// a string: a game name with a quote in it is text, never markup.

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  games: [],
  current: null,
  plan: null,
  info: null,
  settings: { theme: 'dark', fetchArtwork: true, allowUnknownRuntime: false },
  filters: { text: '', api: '', status: '', store: '', quick: new Set() },
  covers: new Map(),          // game id -> { cover, hero } promises, so each picture crosses once
  acknowledged: false,        // anti-cheat consent for the sheet that is open, never remembered
  view: 'home',
};

const STORE_ORDER = ['Steam', 'Xbox', 'Manual'];
const STORE_LABEL = { Steam: 'Steam', Xbox: 'Xbox Game Pass', Manual: 'Added by hand' };
const API_LABEL = {
  d3d12: 'DirectX 12', d3d11: 'DirectX 11', d3d9: 'DirectX 9', d3d8: 'DirectX 8',
  ddraw: 'DirectDraw', vulkan: 'Vulkan', opengl: 'OpenGL', dxgi: 'DXGI',
};
const API_SHORT = { d3d12: 'DirectX 12', d3d11: 'DirectX 11', d3d9: 'DirectX 9', d3d8: 'DirectX 8', ddraw: 'DirectDraw', vulkan: 'Vulkan', opengl: 'OpenGL', dxgi: 'DXGI' };
const VIEW_TITLE = { home: 'Home', library: 'Games', media: 'Media', runtimes: 'Runtimes', log: 'Log', settings: 'Settings', about: 'About' };

// ---------------------------------------------------------------- helpers

function text(node, value) { node.textContent = value === undefined || value === null ? '' : String(value); }

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) text(node, content);
  return node;
}

function banner(node, content) {
  if (!content) { node.hidden = true; text(node, ''); return; }
  node.hidden = false;
  text(node, content);
}

function storeClass(store) { return `store-${String(store || 'manual').toLowerCase()}`; }

function apiLabel(exe) {
  if (!exe) return 'no executable';
  return exe.api === 'unknown' ? 'API not detected' : (API_LABEL[exe.api] || exe.api);
}

// What was actually found, said plainly. "loaded at runtime" is how Unreal and
// Unity work and should not read as a problem.
function describeExe(exe) {
  if (!exe) return 'no executable found';
  const how = exe.apiSource === 'dynamic' ? ', loaded at runtime' : '';
  const engine = exe.canonical ? ` · ${exe.canonical === 'unreal' ? 'Unreal' : 'Unity'}` : '';
  return `${exe.name} · ${apiLabel(exe)}${how} · ${exe.bitness}-bit${engine}`;
}

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return date.toLocaleDateString();
}

let toastTimer = null;
function toast(message) {
  $$('.toast').forEach(node => node.remove());
  const node = element('div', 'toast', message);
  document.body.appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2600);
}

// ---------------------------------------------------------------- theme + shell

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  $$('#theme-seg button').forEach(button => button.classList.toggle('is-on', button.dataset.theme === document.documentElement.dataset.theme));
}

async function setTheme(theme) {
  applyTheme(theme);
  const response = await window.api.setSettings({ theme });
  if (response.ok) state.settings = response.settings;
}

function show(view) {
  state.view = view;
  $$('.view').forEach(section => section.classList.toggle('is-active', section.id === `view-${view}`));
  $$('.nav-item').forEach(tab => tab.classList.toggle('is-active', tab.dataset.view === view));
  text($('#crumb'), VIEW_TITLE[view] || '');
  if (view === 'runtimes') loadRuntimes();
  if (view === 'media') loadMedia();
  if (view === 'log') loadLog();
  if (view === 'settings') loadSettings();
  if (view === 'home') { renderRecent(); loadActivity(); }
}

function setStatus({ title, tone, sub }) {
  if (title !== undefined) text($('#status-title'), title);
  if (tone !== undefined) $('#status-dot').className = `live${tone ? ` ${tone}` : ''}`;
  if (sub !== undefined) text($('#status-runtime'), sub);
}

function setProgress() {
  const total = state.games.length;
  const done = state.games.filter(game => game.installed).length;
  $('#status-bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
}

// ---------------------------------------------------------------- covers

// One request per picture per game, whatever asks for it and however often.
function coverFor(game, kind) {
  let entry = state.covers.get(game.id);
  if (!entry) { entry = {}; state.covers.set(game.id, entry); }
  if (!entry[kind]) {
    entry[kind] = window.api.getCover({ id: game.id, dir: game.dir, store: game.store, appid: game.appid, name: game.name }, [kind])
      .then(response => (response.ok && response[kind]) ? response[kind] : null)
      .catch(() => null);
  }
  return entry[kind];
}

const lazyCovers = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    lazyCovers.unobserve(entry.target);
    const game = state.games.find(item => item.id === entry.target.dataset.id);
    if (game) fillPoster(entry.target, game);
  }
}, { rootMargin: '200px' });

function drawnTile(game, store) {
  const placeholder = element('div', `placeholder ${storeClass(store || game.store)}`);
  placeholder.appendChild(element('i', 'rule'));
  placeholder.appendChild(element('div', 'title', game.name));
  return placeholder;
}

async function fillPoster(poster, game) {
  const found = await coverFor(game, 'cover');
  if (!found) return;
  const img = document.createElement('img');
  img.alt = '';
  img.className = 'is-loading';
  img.addEventListener('load', () => {
    img.classList.remove('is-loading');
    poster.querySelectorAll('.placeholder').forEach(node => node.remove());
  });
  img.src = found.dataUrl;
  poster.insertBefore(img, poster.firstChild);
}

// ---------------------------------------------------------------- library

async function loadLibrary() {
  const target = $('#library');
  target.replaceChildren(element('p', 'muted', 'Scanning…'));
  setStatus({ title: 'Scanning', tone: 'busy' });
  const response = await window.api.listGames();
  if (!response.ok) {
    target.replaceChildren(element('p', 'banner warn', response.error));
    setStatus({ title: 'Scan failed', tone: 'warn' });
    return;
  }
  state.games = response.games;
  setStatus({ title: 'Ready', tone: '' });
  setProgress();
  renderLibrary();
  renderRecent();
  loadActivity();
}

function matches(game) {
  const f = state.filters;
  if (f.store && game.store !== f.store) return false;
  if (f.text && !game.name.toLowerCase().includes(f.text)) return false;
  if (f.api) {
    const api = game.exe ? game.exe.api : 'unknown';
    if (f.api !== api) return false;
  }
  if (f.status === 'installed' && !game.installed) return false;
  if (f.status === 'not' && game.installed) return false;
  if (f.status === 'anticheat' && !game.anticheat.length) return false;
  if (f.status === '32' && !(game.exe && game.exe.bitness === 32)) return false;
  if (f.quick.has('dx12') && !(game.exe && game.exe.api === 'd3d12')) return false;
  if (f.quick.has('installed') && !game.installed) return false;
  if (f.quick.has('anticheat') && !game.anticheat.length) return false;
  return true;
}

function renderQuickFilters(pool) {
  const chips = [
    { key: 'dx12', count: pool.filter(g => g.exe && g.exe.api === 'd3d12').length, label: n => `${n} on DirectX 12` },
    { key: 'installed', count: pool.filter(g => g.installed).length, label: n => `${n} installed` },
    { key: 'anticheat', count: pool.filter(g => g.anticheat.length).length, label: n => `${n} with anti-cheat` },
  ];
  $('#quick-filters').replaceChildren(...chips.map(chip => {
    const button = element('button', 'filter-chip', chip.label(chip.count));
    button.setAttribute('aria-pressed', state.filters.quick.has(chip.key) ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (state.filters.quick.has(chip.key)) state.filters.quick.delete(chip.key); else state.filters.quick.add(chip.key);
      renderLibrary();
    });
    return button;
  }));
}

function makeCard(game) {
  const card = element('button', `card ${storeClass(game.store)}`);
  card.classList.toggle('is-installed', Boolean(game.installed));
  card.classList.toggle('is-blocked', game.anticheat.length > 0);
  card.dataset.id = game.id;
  card.title = describeExe(game.exe);

  const poster = element('div', 'poster');
  poster.dataset.id = game.id;
  poster.appendChild(drawnTile(game));

  if (game.exe) {
    const api = game.exe.api === 'unknown' ? 'No API' : (API_SHORT[game.exe.api] || game.exe.api);
    const badge = element('span', 'badge', game.exe.bitness === 32 ? `${api} · 32-bit` : api);
    if (game.exe.api === 'd3d12') badge.classList.add('dx12');
    if (game.exe.bitness === 32) badge.classList.add('warn');
    poster.appendChild(badge);
  }

  const status = element('div', 'status');
  const dot = element('i', 'dot-s');
  dot.classList.toggle('on', Boolean(game.installed));
  status.appendChild(dot);
  status.appendChild(element('span', null, game.installed
    ? (game.managed ? 'Installed' : 'Installed · found')
    : (game.route === 'relay' ? 'Not installed · relay' : game.route === 'optiscaler' ? 'Not installed · OptiScaler' : 'Not installed')));
  if (game.anticheat.length) status.appendChild(element('span', 'ac', game.anticheat[0]));
  poster.appendChild(status);

  card.appendChild(poster);
  card.appendChild(element('div', 'name', game.name));
  card.addEventListener('click', () => openGame(game));
  lazyCovers.observe(poster);
  return card;
}

function renderLibrary() {
  const scope = state.games.filter(game => !state.filters.store || game.store === state.filters.store);
  renderQuickFilters(scope);
  const rows = state.games.filter(matches);
  text($('#library-count'), state.games.length ? `${rows.length} of ${state.games.length} shown` : '');
  const target = $('#library');

  if (!rows.length) {
    const empty = element('div', 'glass games-empty');
    empty.appendChild(element('h4', null, state.games.length ? 'Nothing matches those filters.' : 'No games found yet.'));
    empty.appendChild(element('p', null, state.games.length
      ? 'Clear a filter or two, or search for a different title.'
      : 'Steam and Xbox Game Pass libraries are found on their own. Use "Add a folder" to point at anything else.'));
    target.replaceChildren(empty);
    return;
  }

  const groups = STORE_ORDER
    .map(store => ({ store, games: rows.filter(game => game.store === store) }))
    .filter(group => group.games.length);

  target.replaceChildren(...groups.map(group => {
    const section = element('section', `group ${storeClass(group.store)}`);
    const head = element('div', 'group-head');
    head.appendChild(element('h4', null, STORE_LABEL[group.store] || group.store));
    head.appendChild(element('span', 'count', `${group.games.length} game${group.games.length === 1 ? '' : 's'}`));
    const installed = group.games.filter(game => game.installed).length;
    if (installed) head.appendChild(element('span', 'ready', `${installed} installed`));
    section.appendChild(head);
    const grid = element('div', 'grid');
    grid.append(...group.games.map(makeCard));
    section.appendChild(grid);
    return section;
  }));
}

function renderRecent() {
  const recent = state.games
    .filter(game => game.installed && game.installedAt)
    .sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)))
    .slice(0, 6);
  text($('#recent-count'), recent.length ? `${recent.length}` : '');
  const target = $('#recent-grid');
  if (!recent.length) {
    const note = element('div', 'glass empty-note');
    note.appendChild(element('h4', null, 'Nothing installed yet'));
    note.appendChild(element('div', null, 'Pick a game under Games. Everything it touches is backed up first.'));
    target.replaceChildren(note);
    return;
  }
  target.replaceChildren(...recent.map(game => {
    const card = makeCard(game);
    const strip = card.querySelector('.status span');
    if (strip) text(strip, `Installed ${when(game.installedAt)}`);
    return card;
  }));
}

// ---------------------------------------------------------------- activity

// HH:MM:SS in this PC's time zone (entries carry UTC ISO timestamps).
function clockTime(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return String(at).slice(11, 19);
  const two = n => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function activityRow(entry) {
  const row = element('div', 'log-row');
  if (entry.level !== 'info') row.classList.add(entry.level);
  row.appendChild(element('i'));
  row.appendChild(element('span', 't', `[${clockTime(entry.at)}]`));
  row.appendChild(element('span', 'm', entry.message));
  return row;
}

async function loadActivity() {
  const response = await window.api.listActivity();
  const target = $('#activity-log');
  if (!response.ok) { target.replaceChildren(element('p', 'empty', response.error)); return; }
  if (!response.entries.length) { target.replaceChildren(element('p', 'empty', 'Nothing yet.')); return; }
  target.replaceChildren(...response.entries.slice(-80).map(activityRow));
  target.scrollTop = target.scrollHeight;
}

function appendActivity(entry) {
  const target = $('#activity-log');
  if (!target) return;
  const empty = target.querySelector('.empty');
  if (empty) empty.remove();
  target.appendChild(activityRow(entry));
  while (target.children.length > 80) target.removeChild(target.firstChild);
  target.scrollTop = target.scrollHeight;
  if (entry.level === 'error') setStatus({ title: 'Attention', tone: 'warn' });
}

// ---------------------------------------------------------------- game sheet

function openGame(game) {
  state.current = game;
  state.acknowledged = false;
  const overlay = $('#view-game');
  overlay.hidden = false;
  overlay.classList.remove('is-open');
  $('#game-result').hidden = true;
  text($('#game-name'), game.name);
  text($('#game-path'), game.dir);
  text($('#game-sub'), `${STORE_LABEL[game.store] || game.store} · ${describeExe(game.exe)}`);
  // Only a folder the user added by hand can be forgotten; a scanned one would
  // simply come back on the next rescan.
  $('#forget-folder').hidden = game.store !== 'Manual';

  const hero = $('#game-hero');
  hero.className = `hero empty ${storeClass(game.store)}`;
  hero.querySelectorAll('img').forEach(node => node.remove());
  const cover = $('#hero-cover');
  cover.replaceChildren(drawnTile(game));

  coverFor(game, 'cover').then(found => {
    if (state.current !== game || !found) return;
    const img = document.createElement('img'); img.alt = ''; img.src = found.dataUrl;
    cover.replaceChildren(img);
  });
  coverFor(game, 'hero').then(found => {
    if (state.current !== game || !found) return;
    const img = document.createElement('img'); img.alt = ''; img.src = found.dataUrl;
    hero.insertBefore(img, hero.firstChild);
    hero.classList.remove('empty');
  });

  $('.sheet').scrollTop = 0;
  refreshPlan();
}

function closeGame() {
  $('#view-game').hidden = true;
  state.current = null;
  state.plan = null;
}

function chosenProfile() {
  return {
    Passes: $('#opt-passes').value,
    Model: $('#opt-model').value,
    FrameGeneration: $('#opt-fg').value,
    FrameGenMultiplier: $('#opt-fgmult').value,
  };
}

function specRow(label, value, tone, sub) {
  const row = element('div', 'spec');
  row.appendChild(element('span', 'k', label));
  const v = element('span', 'v', value);
  if (tone) v.classList.add(tone);
  if (sub) v.appendChild(element('span', 'sub', sub));
  row.appendChild(v);
  return row;
}

function renderSpecs(plan) {
  const exe = plan.exe;
  const rows = [];
  rows.push(specRow('Executable', exe ? exe.name : 'none chosen', exe ? '' : 'bad',
    exe && exe.canonical ? `${exe.canonical === 'unreal' ? 'Unreal' : 'Unity'} shipping layout` : (exe && !exe.renders ? 'no graphics runtime found - may be a launcher' : null)));
  rows.push(specRow('Architecture', exe ? `${exe.bitness}-bit` : '—', exe && exe.bitness === 32 ? 'warn' : ''));
  rows.push(specRow('Rendering API', apiLabel(exe), exe && exe.api === 'd3d12' ? 'on' : '',
    exe && exe.apiSource === 'dynamic' ? 'loaded at runtime' : (exe && exe.apiSource === 'import' ? 'from the import table' : null)));
  rows.push(specRow('ReShade hook', plan.hook));
  const routeLabel = plan.route === 'relay' ? 'neural relay (32-bit game)'
    : plan.route === 'optiscaler' ? 'OptiScaler (native ray reconstruction)' : 'in the game folder';
  const routeHint = plan.route === 'relay' ? 'the relay captures the window and overlays the result; set the game to windowed or borderless'
    : plan.route === 'optiscaler' ? 'neural rendering inside the game\'s own DLSS pass; turn DLSS on in game, Insert opens its menu' : null;
  rows.push(specRow('Route', routeLabel, '', routeHint));
  rows.push(specRow('DLSS 5 add-on',
    plan.alreadyInstalled ? `Installed · build ${plan.installedBuild || 'unknown'}${buildOutdated(plan) ? ` · ${plan.build} available` : ''}`
      : `Not installed · build ${plan.build} ready`,
    plan.alreadyInstalled ? 'on' : 'off',
    plan.alreadyInstalled
      ? (plan.managed ? `installed ${when(plan.installedAt)} by this app` : 'found on disk - not installed by this app, so no backups yet')
      : null));
  rows.push(specRow('NVIDIA runtime', plan.runtime ? `${(plan.runtime.bytes / (1024 * 1024)).toFixed(0)} MB` : 'not found on this PC',
    plan.runtime ? 'on' : 'bad', plan.runtime ? plan.runtime.from : 'see Runtimes'));
  rows.push(specRow('Backup', plan.managed && plan.backupDir ? 'originals kept' : 'made before anything is written',
    plan.managed && plan.backupDir ? 'on' : '', plan.managed && plan.backupDir ? plan.backupDir : null));
  if (plan.anticheat.length) rows.push(specRow('Anti-cheat', plan.anticheat.join(', '), 'bad', 'never bypassed - the risk is yours'));
  const gpu = plan.machine && plan.machine.gpu;
  const nr = plan.machine && plan.machine.verdicts && plan.machine.verdicts.nr;
  if (gpu && gpu.available) {
    rows.push(specRow('This PC', gpu.name.replace(/^NVIDIA GeForce /, ''), nr && nr.ok === false ? 'bad' : nr && nr.ok ? 'on' : '',
      nr && nr.ok === false ? `${gpu.architectureName} - cannot run the neural renderer` : gpu.architectureName || 'generation not recognised'));
  }
  $('#spec-table').replaceChildren(...rows);
}

// An installed add-on whose embedded build differs from the one this app carries - offer it as an update.
function buildOutdated(plan) {
  return Boolean(plan && plan.alreadyInstalled && plan.installedBuild && plan.build && plan.installedBuild !== plan.build);
}

async function refreshPlan() {
  const game = state.current;
  if (!game) return;
  const exeName = $('#exe-picker').value || undefined;
  const response = await window.api.planGame(game.dir, exeName, chosenProfile());
  if (state.current !== game) return;
  if (!response.ok) { banner($('#problem-banner'), response.error); return; }
  const plan = response.plan;
  state.plan = plan;

  // Executable picker - rebuilt only when the list actually changed, so
  // choosing one does not yank the dropdown out from under the click.
  const picker = $('#exe-picker');
  const wanted = `${game.dir}|${plan.candidates.map(c => c.name).join('|')}`;
  if (picker.dataset.signature !== wanted) {
    picker.dataset.signature = wanted;
    picker.replaceChildren(...plan.candidates.map(candidate => {
      const option = document.createElement('option');
      option.value = candidate.name;
      option.textContent = describeExe(candidate) + (candidate.demoted ? '  - not the game' : '');
      return option;
    }));
  }
  if (plan.exe) picker.value = plan.exe.name;

  const picked = plan.candidates.length > 1 ? ` - ${plan.candidates.length} executables were found here; the one above was picked` : '';
  text($('#hook-note'), !plan.exe ? 'No executable could be chosen in this folder.'
    : plan.route === 'optiscaler'
      ? `OptiScaler loads beside ${plan.exe.name}${picked}. Of the settings above only Neural passes applies here; model, frame generation and the rest are the game's own DLSS settings and OptiScaler's Insert menu.`
      : `ReShade loads as ${plan.hook} beside ${plan.exe.name}${picked}.`);
  renderSpecs(plan);

  $('#file-list').replaceChildren(...plan.files.map(file => {
    const row = element('div', 'filerow');
    row.appendChild(element('span', 'f', file.action === 'park'
      ? `${file.from}  →  ${file.to}`
      : file.to + (file.shared ? '   (machine-wide, shared)' : file.outsideGame ? '   (machine-wide)' : file.action === 'ini' ? '   (settings)' : '')));
    row.appendChild(element('span', 'r', file.role));
    return row;
  }));

  // Reflect what the plan settled on, so a saved profile shows up in the boxes.
  $('#opt-passes').value = plan.profile.Passes || '2';
  $('#opt-model').value = plan.profile.Model || '3';
  $('#opt-fg').value = plan.profile.FrameGeneration || '1';
  $('#opt-fgmult').value = plan.profile.FrameGenMultiplier || '2';

  renderAntiCheat(plan);
  banner($('#changed-banner'), plan.managed && plan.intact === false && plan.verifySummary
    ? `Changed since the install\n${plan.verifySummary}\n\n${(plan.changedSinceInstall || []).join('\n')}` : null);
  banner($('#problem-banner'), plan.problems.length ? plan.problems.join('\n\n') : null);
  banner($('#note-banner'), plan.notes.length ? plan.notes.join('\n') : null);

  $('#do-install').disabled = !plan.installable;
  text($('#do-install'), plan.alreadyInstalled
    ? (buildOutdated(plan) ? `Update to ${plan.build}` : (plan.managed ? 'Reinstall' : 'Install this build')) : 'Install');
  $('#do-restore').disabled = !plan.managed;
  $('#do-restore').title = plan.alreadyInstalled && !plan.managed ? 'Installed outside this app: there are no backups to restore from.' : '';
}

// Consent lives in this sheet only. Nothing remembers it, nothing skips it.
function renderAntiCheat(plan) {
  const node = $('#anticheat-banner');
  if (!plan.anticheatWarning) { node.hidden = true; node.replaceChildren(); return; }
  node.hidden = false;
  node.replaceChildren();
  node.appendChild(element('div', null, plan.anticheatWarning));
  const row = element('div', 'row');
  if (state.acknowledged) {
    row.appendChild(element('span', 'dim', 'Acknowledged for this sheet. Nothing here bypasses anti-cheat.'));
  } else {
    const accept = element('button', 'ghost sm danger', 'I understand the risk - allow install');
    accept.addEventListener('click', () => { state.acknowledged = true; renderAntiCheat(plan); });
    row.appendChild(accept);
  }
  row.style.marginTop = '10px';
  node.appendChild(row);
}

function result(message) {
  const node = $('#game-result');
  node.hidden = false;
  text(node, message);
  node.scrollIntoView({ block: 'nearest' });
}

// What this folder has been through, appended under the result so the outcome
// and the record of it are in the same place.
async function appendHistory() {
  if (!state.current) return;
  const response = await window.api.gameStatus(state.current.dir);
  if (!response.ok || !response.history || !response.history.length) return;
  const lines = response.history.slice(-6).map(entry => {
    const stamp = String(entry.at || '').replace('T', ' ').slice(0, 19);
    return `  ${stamp}  ${entry.action}${entry.build ? `  ${entry.build}` : ''}`;
  });
  const node = $('#game-result');
  text(node, `${node.textContent}\n\nHistory\n${lines.join('\n')}`);
}

function updateGame(dir, patch) {
  const game = state.games.find(item => item.dir === dir);
  if (game) Object.assign(game, patch);
  setProgress();
  renderLibrary();
  renderRecent();
}

async function doInstall() {
  const plan = state.plan;
  if (!plan || !state.current) return;
  if (plan.anticheat.length && !state.acknowledged) {
    result('Anti-cheat was found in this folder. Read the warning above and allow the install there first. Nothing was written.');
    $('#anticheat-banner').scrollIntoView({ block: 'nearest' });
    return;
  }
  const game = state.current;
  $('#do-install').disabled = true;
  setStatus({ title: 'Installing', tone: 'busy' });
  const response = await window.api.installGame(game.dir, $('#exe-picker').value, chosenProfile(), state.acknowledged);
  $('#do-install').disabled = false;
  setStatus({ title: 'Ready', tone: '' });
  if (!response.ok) {
    result(response.code === 'GAME_RUNNING'
      ? `${response.error}\n\nNothing was written.`
      : response.code === 'ANTICHEAT_CONSENT_REQUIRED'
        ? `${response.error}\n\nNothing was written.`
        : `Install failed: ${response.error}\n\nEvery file was put back.`);
    return;
  }
  const manifest = response.manifest;
  result(`Installed build ${manifest.build}.\n`
    + manifest.files.map(file => `  ${file.to}`).join('\n')
    + '\n\nOriginals are backed up. "Restore originals" puts them all back.');
  updateGame(game.dir, { installed: true, managed: true, route: manifest.route, installedAt: manifest.installedAt, installedBuild: manifest.build });
  if (state.current === game) { await refreshPlan(); await appendHistory(); }
  toast(`Installed into ${game.name}`);
}

async function doRestore() {
  const game = state.current;
  if (!game) return;
  $('#do-restore').disabled = true;
  const response = await window.api.restoreGame(game.dir);
  $('#do-restore').disabled = false;
  if (!response.ok) { result(`Restore failed: ${response.error}`); return; }
  const { restored, removed, failures, left, skipped } = response.result;
  result(`${restored.length} original(s) restored, ${removed.length} added file(s) removed.`
    + (left && left.length ? `\n${left.length} machine-wide runtime file(s) left in place - other games share them.` : '')
    + (skipped && skipped.length ? `\n${skipped.length} file(s) changed since the install (a game update?) were left alone - the newer file is what the game wants.` : '')
    + (failures.length ? '\n\n' + failures.map(failure => `! ${failure}`).join('\n') : ''));
  updateGame(game.dir, { installed: false, managed: false, installedAt: null, installedBuild: null });
  if (state.current === game) { await refreshPlan(); await appendHistory(); }
  toast(`Restored ${game.name}`);
}

async function doVerify() {
  const game = state.current;
  if (!game) return;
  const response = await window.api.verifyGame(game.dir);
  if (!response.ok) { result(`Verify failed: ${response.error}`); return; }
  const check = response.check;
  if (!check.installed) { result('Nothing is installed here by this app.'); return; }
  const settingsNote = (check.settings || []).length
    ? `\n\n${check.settings.length} settings file(s) not compared - ReShade and OptiScaler rewrite their own settings as you change them.`
    : '';
  result((check.gameUpdated
    ? `${check.summary}\n\n${[...check.changed.map(f => `changed  ${f}`), ...check.missing.map(f => `missing  ${f}`)].join('\n')}`
    : `All ${check.checked} installed file(s) are still exactly as installed.`) + settingsNote);
  if (state.current === game) await refreshPlan();
}

// ---------------------------------------------------------------- runtimes

const RUNTIME_NAMES = { nr: 'nvngx_dlssnr.dll', sr: 'nvngx_dlss.dll', fg: 'nvngx_dlssg.dll' };
const RUNTIME_ROLE = { nr: 'DLSS 5 neural rendering', sr: 'super resolution', fg: 'frame generation' };

// What this PC is, and whether each runtime's kernels exist for its card. The
// minimum generation is read off each runtime file; the card comes from the
// driver. An unknown card is shown as unknown, never guessed.
function renderMachine(machine) {
  const rows = [];
  const gpu = machine && machine.gpu;
  if (gpu && gpu.available) {
    rows.push(specRow('GPU', gpu.name, gpu.architecture ? '' : 'warn',
      gpu.architectureName ? `${gpu.architectureName}${gpu.driver ? ` · driver ${gpu.driver}` : ''}` : 'generation not recognised - no check possible'));
  } else {
    rows.push(specRow('GPU', 'no NVIDIA GPU reported', 'bad', 'nvidia-smi and WMI both came back empty'));
  }
  const hags = machine && machine.hags;
  if (hags && hags.available) {
    rows.push(specRow('Hardware-accelerated GPU scheduling', hags.state, hags.state === 'on' ? 'on' : hags.state === 'off' ? 'warn' : 'off',
      hags.state === 'off' ? 'frame generation needs it on' : null));
  }
  for (const kind of ['nr', 'sr', 'fg']) {
    const info = machine && machine.runtimes && machine.runtimes[kind];
    const verdict = machine && machine.verdicts && machine.verdicts[kind];
    if (!info) continue;
    const tone = verdict && verdict.ok === true ? 'on' : verdict && verdict.ok === false ? 'bad' : '';
    rows.push(specRow(`${RUNTIME_NAMES[kind]} ${info.fileVersion || ''}`.trim(),
      `needs ${info.minArchitectureName || 'unknown'}`, tone,
      verdict && verdict.ok === true ? 'this card can run it' : verdict && verdict.ok === false ? 'this card cannot run it' : null));
  }
  return rows;
}

async function loadRuntimes() {
  const response = await window.api.locateRuntimes();
  if (!response.ok) { text($('#runtime-state'), response.error); return; }
  text($('#runtime-state'), response.state.message);
  $('#runtime-state').className = `banner ${response.state.ok ? 'note' : 'warn'}`;

  const machine = response.machine || {};
  $('#machine-specs').replaceChildren(...renderMachine(machine));
  const lines = [...(machine.problems || []), ...(machine.notes || [])];
  banner($('#machine-banner'), lines.length ? lines.join('\n\n') : null);
  $('#machine-banner').className = `banner ${(machine.problems || []).length ? 'danger' : 'warn'}`;

  const gpu = machine.gpu;
  const blocked = (machine.problems || []).length > 0;
  setStatus({
    sub: blocked ? 'this GPU cannot run neural rendering - see Runtimes'
      : response.state.ok ? `runtimes: found${gpu && gpu.available && gpu.name ? ` · ${gpu.name.replace(/^NVIDIA GeForce /, '')}` : ''}` : 'runtimes: not found - see Runtimes',
    tone: blocked ? 'warn' : undefined,
  });

  $('#runtime-files').replaceChildren(...Object.entries(response.files).map(([kind, hit]) => {
    if (!hit) return specRow(`${RUNTIME_NAMES[kind]} · ${RUNTIME_ROLE[kind]}`, 'not found on this PC', kind === 'nr' ? 'bad' : 'off', null);
    const tone = hit.known ? 'on' : (kind === 'nr' ? 'bad' : 'warn');
    const sig = hit.signature || {};
    const value = `${hit.version || 'version ?'} · ${(hit.bytes / (1024 * 1024)).toFixed(0)} MB · `
      + (hit.known ? 'validated copy' : (kind === 'nr' ? 'NOT a validated copy' : 'not the validated version'))
      + (sig.text ? ` · ${sig.text}` : '');
    const sub = `${hit.from}${hit.sha ? `\nSHA-256 ${hit.sha}` : ''}`;
    return specRow(`${RUNTIME_NAMES[kind]} · ${RUNTIME_ROLE[kind]}`, value, tone, sub);
  }));
  const validated = response.validated;
  const unknownNeural = validated && !validated.neuralKnown;
  banner($('#runtime-validated'), validated
    ? (unknownNeural
      ? `The neural runtime on this PC is not the validated 310.8.0.0 file (SHA-256 e16bcf15…1fc8e, 165,840,496 bytes). `
        + `Installs are ${response.allowUnknownRuntime ? 'allowed by your setting in Settings' : 'refused until it is, or until "Allow an unvalidated neural runtime" is turned on in Settings'}.`
      : 'Every runtime found is a validated copy - hashes match the files this build was tested with.'
        + (validated.notes.length ? '\n' + validated.notes.join('\n') : ''))
    : null);
  $('#runtime-validated').className = `banner ${unknownNeural ? 'danger' : 'note'}`;

  renderRuntimeDirs($('#runtime-extra'), response.extraDirs || []);

  $('#runtime-searched').replaceChildren(...response.searched.map(entry =>
    element('li', entry.found.length ? 'hit' : '', `${entry.found.length ? '✓' : '·'}  ${entry.dir}`)));
}

function renderRuntimeDirs(target, dirs) {
  if (!dirs.length) { target.replaceChildren(specRow('None added', 'the automatic places are searched', 'off')); return; }
  target.replaceChildren(...dirs.map(dir => {
    const row = specRow('Folder', dir);
    const forget = element('button', 'ghost sm', 'Forget');
    forget.addEventListener('click', async () => {
      await window.api.forgetRuntimeDir(dir);
      loadRuntimes();
      loadSettings();
    });
    row.appendChild(forget);
    return row;
  }));
}

async function browseRuntimes() {
  const response = await window.api.browseRuntimes();
  if (!response.ok) { toast(response.error); return; }
  if (response.added) toast('Runtime folder added');
  loadRuntimes();
  loadSettings();
}

// ---------------------------------------------------------------- log

async function loadLog() {
  const body = $('#log-body');
  body.replaceChildren(element('p', 'muted', 'Reading…'));
  const response = await window.api.readLog();
  if (!response.ok) { body.replaceChildren(element('div', 'banner warn', response.error)); text($('#log-path'), ''); return; }
  text($('#log-path'), response.file);

  const ms = value => (value === null || value === undefined ? 'n/a' : `${value.toFixed(1)} ms`);
  const stat = (label, value) => {
    const row = element('div', 'stat');
    row.appendChild(element('span', 'label', label));
    row.appendChild(element('span', 'value', value));
    return row;
  };
  const sections = response.reports.map(report => {
    const card = element('div', 'session');
    card.appendChild(element('h4', null, report.header.slice(0, 140)));
    if (report.empty) { card.appendChild(element('p', 'muted', 'No telemetry in this session.')); return card; }
    card.appendChild(stat('real / output fps', `${report.real ?? '?'} / ${report.output ?? '?'}`));
    card.appendChild(stat('GPU per frame', `NR ${ms(report.nr)} + DLAA ${ms(report.dlaa)} + FG ${ms(report.fg)} = ${ms(report.total)}`));
    card.appendChild(stat('pipeline period', ms(report.period)));
    if (report.latency) {
      card.appendChild(stat('input to screen', ms(report.latency.total)));
      card.appendChild(stat('  of which, after Present', ms(report.latency.presentToScanout)));
    }
    for (const verdict of report.verdicts) {
      const row = element('div', 'verdict');
      row.appendChild(element('span', verdict.good ? 'good' : 'bad', verdict.good ? '✓' : '!'));
      row.appendChild(element('span', null, `${verdict.name}: ${verdict.value} - ${verdict.verdict}`));
      card.appendChild(row);
    }
    for (const warning of report.warnings) card.appendChild(element('div', 'warning', `! ${warning}`));
    return card;
  });
  body.replaceChildren(...(sections.length ? sections : [element('p', 'muted', 'No sessions in this log yet.')]));
}

// ---------------------------------------------------------------- settings + about

async function loadSettings() {
  const response = await window.api.getSettings();
  if (response.ok) state.settings = response.settings;
  applyTheme(state.settings.theme);
  $('#artwork-switch').setAttribute('aria-checked', state.settings.fetchArtwork ? 'true' : 'false');
  $('#unknown-runtime-switch').setAttribute('aria-checked', state.settings.allowUnknownRuntime ? 'true' : 'false');
  if (state.info) text($('#settings-app-root'), state.info.appRoot);
  const runtimes = await window.api.locateRuntimes();
  if (runtimes.ok) renderRuntimeDirs($('#settings-runtime-dirs'), runtimes.extraDirs || []);
}

function renderAbout(info) {
  text($('#about-version'), `version ${info.version} · add-on build ${info.build}`);
  text($('#about-build'), info.build);
}

// ---------------------------------------------------------------- updates
//
// The words and the buttons come from main (core/update.js decides them); the
// page only shows them. "Later" hides the bar for this state until something
// new happens.

const updates = { view: null, dismissed: null };

const UPDATE_BUTTONS = {
  allow: '#update-allow', deny: '#update-deny', download: '#update-download',
  notes: '#update-notes', restart: '#update-restart', later: '#update-later',
};

function updateKey(view) {
  const s = (view && view.state) || {};
  return `${view && view.consent}|${s.state}|${s.version || ''}`;
}

function renderUpdate(view) {
  if (view) updates.view = view;
  const v = updates.view;
  if (!v) return;
  const bar = v.bar || { message: '', actions: [] };
  const hidden = !bar.message || updates.dismissed === updateKey(v);
  $('#update-bar').hidden = hidden;
  text($('#update-text'), bar.message || '');
  for (const [action, id] of Object.entries(UPDATE_BUTTONS)) $(id).hidden = hidden || !bar.actions.includes(action);
  text($('#update-status'), v.status || '');
  $('#update-switch').setAttribute('aria-checked', v.consent === true ? 'true' : 'false');
  $('#update-check').disabled = !v.enabled || (v.state && ['checking', 'downloading'].includes(v.state.state));
}

async function loadUpdate() {
  const response = await window.api.updateGet();
  if (response.ok) renderUpdate(response);
}

async function setUpdateConsent(allow) {
  const response = await window.api.updateConsent(allow);
  if (response.ok) renderUpdate(response);
  else toast(response.error);
}

function wireUpdates() {
  window.api.onUpdate(view => renderUpdate(view));
  $('#update-allow').addEventListener('click', () => setUpdateConsent(true));
  $('#update-deny').addEventListener('click', () => setUpdateConsent(false));
  $('#update-switch').addEventListener('click', () => setUpdateConsent($('#update-switch').getAttribute('aria-checked') !== 'true'));
  $('#update-later').addEventListener('click', () => { updates.dismissed = updateKey(updates.view); renderUpdate(); });
  $('#update-check').addEventListener('click', async () => {
    updates.dismissed = null;
    const response = await window.api.updateCheck();
    if (!response.ok) toast(response.error);
  });
  $('#update-download').addEventListener('click', async () => {
    const response = await window.api.updateDownload();
    if (!response.ok) toast(response.error);
  });
  $('#update-restart').addEventListener('click', async () => {
    const response = await window.api.updateInstall();
    if (!response.ok) toast(response.error);
  });
}

// ---------------------------------------------------------------- drag and drop

function wireDrop() {
  const zone = $('#dropzone');
  // A file dropped anywhere else must not navigate the window away.
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('drop', event => event.preventDefault());
  zone.addEventListener('dragenter', () => zone.classList.add('is-over'));
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-over'); });
  zone.addEventListener('drop', async event => {
    event.preventDefault();
    zone.classList.remove('is-over');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    const response = await window.api.addDroppedFile(file);
    if (!response.ok) { toast(response.error); return; }
    toast(`Added ${response.game ? response.game.name : 'folder'}`);
    await loadLibrary();
    const game = state.games.find(item => item.dir === response.added);
    if (game) { show('library'); openGame(game); }
  });
}

// ---------------------------------------------------------------- media: pictures, videos, desktop

// The queue lives here; the work happens in the media worker the main process
// starts. Pictures and videos run as separate jobs, pictures first.
const media = {
  items: [],                 // { key, source, name, kind, bytes, status, progress, output, message, nrMs, change, info }
  settings: null,
  job: null,                 // { mode, id } while a job runs
  pending: [],               // kinds still to run after the current job
  run: null,                 // { total, done, failed } across the jobs one Start began
  desktop: { running: false, starting: false, visible: true, stats: null, info: null, lastRender: null, lastLatency: null },
  tab: 'files',
  loaded: false,
  saveTimer: null,
  compare: null,             // item being compared
};

const MEDIA_STATUS = { queued: 'Queued', running: 'Rendering', done: 'Done', error: 'Failed', cancelled: 'Cancelled' };
const keyOf = file => String(file).toLowerCase();

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function loadMedia() {
  if (!media.loaded) {
    media.loaded = true;
    const response = await window.api.mediaGetSettings();
    if (response.ok) media.settings = response.settings;
    renderMediaSettings();
    loadMonitors();
  }
  refreshReadiness();
  renderQueue();
}

async function refreshReadiness() {
  const response = await window.api.mediaReadiness();
  const node = $('#media-readiness');
  if (!response.ok) { banner(node, response.error); node.className = 'banner warn'; return; }
  const problems = [];
  if (!response.worker.ok) problems.push(response.worker.message);
  if (!response.runtime.ok) problems.push(response.runtime.message);
  if (problems.length) { banner(node, problems.join('\n\n')); node.className = 'banner warn'; }
  else {
    banner(node, `Neural runtime ready${response.runtime.version ? ` (${response.runtime.version})` : ''}`
      + `${response.runtime.modified ? ' - community cross-generation build' : ''}. Nothing is uploaded anywhere: every picture and video is rendered on this PC.`);
    node.className = 'banner note';
  }
  $('#media-start').disabled = problems.length > 0 || Boolean(media.job);
  $('#desktop-start').disabled = problems.length > 0 || media.desktop.running || media.desktop.starting;
}

function setMediaTab(tab) {
  media.tab = tab;
  $$('#media-tabs button').forEach(button => button.classList.toggle('is-on', button.dataset.tab === tab));
  $('#media-files-pane').hidden = tab !== 'files';
  $('#media-desktop-pane').hidden = tab !== 'desktop';
}

// ---- settings panel

function renderMediaSettings() {
  const s = media.settings;
  if (!s) return;
  $('#ms-style').value = String(s.style);
  $('#ms-mix').value = String(Math.round(s.mix * 100));
  $('#ms-intensity').value = String(Math.round(s.intensity * 100));
  $('#ms-tone').value = String(Math.round(s.tone * 100));
  $('#ms-structure').value = String(Math.round(s.structure * 100));
  const skinOptions = [...$('#ms-skin').options].map(option => Number(option.value));
  const nearest = skinOptions.reduce((best, value) => Math.abs(value - s.skin) < Math.abs(best - s.skin) ? value : best, skinOptions[0]);
  $('#ms-skin').value = String(nearest);
  $('#ms-automask').setAttribute('aria-checked', s.autoMask ? 'true' : 'false');
  $('#ms-passes').value = String(s.passes);
  const works = [...$('#ms-work').options].map(option => Number(option.value));
  $('#ms-work').value = String(works.includes(s.maxWorkMP) ? s.maxWorkMP : 8.3);
  $('#ms-stabilize').value = String(Math.round(s.stabilize * 100));
  $('#ms-motion').setAttribute('aria-checked', s.motionToNr ? 'true' : 'false');
  $('#ms-codec').value = s.codec;
  $('#ms-quality').value = s.quality;
  $('#ms-audio').value = s.audio;
  $('#ms-format').value = s.imageFormat;
  text($('#ms-outdir'), s.outputDir || 'Next to each original');
  $('#ms-outdir-reset').hidden = !s.outputDir;
  $('#desktop-fps').value = [...$('#desktop-fps').options].some(option => option.value === String(s.fpsCap)) ? String(s.fpsCap) : '60';
  $('#desktop-monitor').value = [...$('#desktop-monitor').options].some(option => option.value === String(s.monitor)) ? String(s.monitor) : '-1';
  $('#desktop-split').setAttribute('aria-checked', s.split ? 'true' : 'false');
  renderSliderValues();
}

function renderSliderValues() {
  text($('#ms-mix-v'), `${$('#ms-mix').value}%`);
  text($('#ms-intensity-v'), (Number($('#ms-intensity').value) / 100).toFixed(2));
  text($('#ms-tone-v'), (Number($('#ms-tone').value) / 100).toFixed(1));
  text($('#ms-structure-v'), (Number($('#ms-structure').value) / 100).toFixed(1));
  text($('#ms-stabilize-v'), Number($('#ms-stabilize').value) === 0 ? 'off' : `${$('#ms-stabilize').value}%`);
}

function readMediaSettings() {
  return {
    style: Number($('#ms-style').value),
    mix: Number($('#ms-mix').value) / 100,
    intensity: Number($('#ms-intensity').value) / 100,
    tone: Number($('#ms-tone').value) / 100,
    structure: Number($('#ms-structure').value) / 100,
    skin: Number($('#ms-skin').value),
    autoMask: $('#ms-automask').getAttribute('aria-checked') === 'true',
    passes: Number($('#ms-passes').value),
    maxWorkMP: Number($('#ms-work').value),
    stabilize: Number($('#ms-stabilize').value) / 100,
    motionToNr: $('#ms-motion').getAttribute('aria-checked') === 'true',
    codec: $('#ms-codec').value,
    quality: $('#ms-quality').value,
    audio: $('#ms-audio').value,
    imageFormat: $('#ms-format').value,
    fpsCap: Number($('#desktop-fps').value),
    monitor: Number($('#desktop-monitor').value),
    split: $('#desktop-split').getAttribute('aria-checked') === 'true',
  };
}

// Saved a moment after the last change; while desktop mode runs the same
// change also goes to it live (look, strength, anti-shimmer - no restart).
function saveMediaSettingsSoon() {
  renderSliderValues();
  clearTimeout(media.saveTimer);
  media.saveTimer = setTimeout(async () => {
    const response = media.desktop.running
      ? await window.api.desktopLook(readMediaSettings())
      : await window.api.mediaSetSettings(readMediaSettings());
    if (response.ok && response.settings) media.settings = response.settings;
  }, 250);
}

// ---- queue

function addMediaFiles(files) {
  let added = 0;
  for (const file of files) {
    const key = keyOf(file.source);
    if (media.items.some(item => item.key === key && (item.status === 'queued' || item.status === 'running'))) continue;
    media.items = media.items.filter(item => item.key !== key);
    media.items.push({ key, source: file.source, name: file.name, kind: file.kind, bytes: file.bytes, status: 'queued', progress: 0 });
    added += 1;
  }
  if (added) toast(`${added} file${added === 1 ? '' : 's'} added`);
  else if (files.length === 0) toast('No pictures or videos in that');
  renderQueue();
}

function renderQueue() {
  const target = $('#media-queue');
  const items = media.items;
  $('#media-drop').classList.toggle('is-compact', items.length > 0);
  text($('#media-count'), items.length ? String(items.length) : '');
  if (!items.length) {
    const empty = element('div', 'empty-note');
    empty.appendChild(element('h4', null, 'Nothing queued'));
    empty.appendChild(element('p', null, 'Add pictures or videos above. Each one is rendered on this PC and saved as a new file.'));
    target.replaceChildren(empty);
  } else {
    target.replaceChildren(...items.map(renderQueueRow));
  }
  const queued = items.filter(item => item.status === 'queued').length;
  $('#media-start').hidden = Boolean(media.job);
  $('#media-cancel').hidden = !media.job;
  $('#media-start').disabled = !queued || Boolean(media.job);
  text($('#media-start'), queued ? `Start ${queued}` : 'Start');
}

function renderQueueRow(item) {
  const row = element('div', `media-row is-${item.status}`);
  const badge = element('span', `kind kind-${item.kind}`, item.kind === 'video' ? 'Video' : 'Picture');
  row.appendChild(badge);
  const main = element('div', 'media-row-main');
  main.appendChild(element('div', 'media-name', item.name));
  const detail = [formatBytes(item.bytes)];
  if (item.info && item.info.width) detail.push(`${item.info.width}×${item.info.height}${item.info.workWidth && item.info.workWidth !== item.info.width ? ` (rendered at ${item.info.workWidth}×${item.info.workHeight})` : ''}`);
  if (item.status === 'running' && item.kind === 'video' && item.progressText) detail.push(item.progressText);
  if (item.status === 'done' && item.nrMs) detail.push(`NR ${item.nrMs.toFixed(1)} ms${item.kind === 'video' ? '/frame' : ''}`);
  if (item.message) detail.push(item.message);
  main.appendChild(element('div', 'media-detail', detail.filter(Boolean).join(' · ')));
  if (item.status === 'running') {
    const bar = element('div', 'bar media-bar');
    const fill = element('i');
    fill.style.width = `${Math.round((item.progress || 0.02) * 100)}%`;
    bar.appendChild(fill);
    main.appendChild(bar);
  }
  row.appendChild(main);
  row.appendChild(element('span', `media-state state-${item.status}`, MEDIA_STATUS[item.status] || item.status));
  const actions = element('div', 'row media-actions');
  if (item.status === 'done' && item.output) {
    const compare = element('button', 'ghost sm', 'Compare');
    compare.addEventListener('click', () => openCompare(item));
    actions.appendChild(compare);
    const reveal = element('button', 'ghost sm', 'Show');
    reveal.addEventListener('click', () => window.api.mediaReveal(item.output));
    actions.appendChild(reveal);
  }
  if (item.status !== 'running') {
    const remove = element('button', 'ghost sm', 'Remove');
    remove.addEventListener('click', () => { media.items = media.items.filter(other => other !== item); renderQueue(); });
    actions.appendChild(remove);
  }
  row.appendChild(actions);
  return row;
}

function jobStatus(message) { text($('#media-job-status'), message || ''); }

async function startMedia() {
  const kinds = ['image', 'video'].filter(kind => media.items.some(item => item.kind === kind && item.status === 'queued'));
  if (!kinds.length) return;
  media.pending = kinds;
  // Pictures and videos run as separate worker jobs; the status line counts the whole run.
  media.run = { total: media.items.filter(item => item.status === 'queued').length, done: 0, failed: 0 };
  await runNextMediaJob();
}

async function runNextMediaJob() {
  const mode = media.pending.shift();
  if (!mode) {
    media.job = null;
    if (media.run) {
      const run = media.run;
      if (run.done || run.failed) jobStatus(run.failed ? `${run.done} done, ${run.failed} failed - the queue says why` : `All ${run.done} done`);
      media.run = null;
    }
    renderQueue(); refreshReadiness(); setStatus({ title: 'Ready', tone: '' }); return;
  }
  const files = media.items.filter(item => item.kind === mode && item.status === 'queued').map(item => item.source);
  if (!files.length) { await runNextMediaJob(); return; }
  const response = await window.api.mediaStart(mode, files, readMediaSettings());
  if (!response.ok) {
    jobStatus(response.error);
    toast(response.error);
    media.pending = [];
    media.job = null;
    renderQueue();
    return;
  }
  media.job = { mode, id: response.job, started: Date.now(), done: 0, total: response.items.length };
  for (const planned of response.items) {
    const item = media.items.find(entry => entry.key === keyOf(planned.input));
    if (item) { item.plannedOutput = planned.output; item.message = null; }
  }
  setStatus({ title: mode === 'image' ? 'Rendering pictures' : 'Rendering videos', tone: 'busy' });
  jobStatus(`Starting neural rendering for ${response.items.length} ${mode === 'image' ? 'picture' : 'video'}${response.items.length === 1 ? '' : 's'}…`);
  renderQueue();
}

function itemForEvent(event) {
  if (!event.input) return null;
  return media.items.find(item => item.key === keyOf(event.input)) || null;
}

function onMediaEvent(event) {
  if (event.slot === 'desktop') { onDesktopEvent(event); return; }
  const item = itemForEvent(event);
  switch (event.event) {
    case 'ready':
      jobStatus(`Rendering on ${event.gpu}${event.driver ? ` · driver ${event.driver}` : ''}`);
      break;
    case 'file-start':
      if (item) { item.status = 'running'; item.progress = 0.02; item.message = null; }
      break;
    case 'file-info': {
      const running = media.items.find(entry => entry.status === 'running');
      if (running) running.info = event;
      if (running && event.hdr) running.message = 'HDR video - rendered as standard range';
      break;
    }
    case 'progress': {
      const running = media.items.find(entry => entry.status === 'running');
      if (running) {
        running.progress = event.duration > 0 ? Math.min(0.99, event.seconds / event.duration) : (event.frames > 0 ? Math.min(0.99, event.frame / event.frames) : 0.5);
        const remaining = event.fps > 0 && event.frames > 0 ? (event.frames - event.frame) / event.fps : NaN;
        running.progressText = `${formatClock(event.seconds)} / ${formatClock(event.duration)} · ${event.fps.toFixed(1)} fps${Number.isFinite(remaining) ? ` · ${formatClock(remaining)} left` : ''}`;
      }
      break;
    }
    case 'file-done':
      if (item) { item.status = 'done'; item.progress = 1; item.output = event.output; item.nrMs = event.nrMs; item.change = event.change; item.message = null; }
      if (media.job) media.job.done += 1;
      if (media.run) media.run.done += 1;
      if (media.run) jobStatus(`${media.run.done} of ${media.run.total} done`);
      else if (media.job) jobStatus(`${media.job.done} of ${media.job.total} done`);
      break;
    case 'file-error':
      if (item) { item.status = 'error'; item.message = event.message; }
      if (media.run) media.run.failed += 1;
      break;
    case 'file-cancelled':
      if (item) { item.status = 'queued'; item.progress = 0; item.message = 'cancelled'; }
      break;
    case 'warning':
      jobStatus(event.message);
      break;
    case 'error':
    case 'crash': {
      const message = event.message || `The media worker crashed (${event.code} in ${event.module}).`;
      jobStatus(message);
      media.items.filter(entry => entry.status === 'running').forEach(entry => { entry.status = 'error'; entry.message = message; });
      break;
    }
    case 'exit': {
      media.items.filter(entry => entry.status === 'running').forEach(entry => {
        entry.status = event.ok ? 'done' : 'error';
        if (!event.ok && !entry.message) entry.message = event.error || 'the worker stopped';
      });
      const cancelled = media.job && media.job.cancelled;
      media.job = null;
      if (cancelled) { media.pending = []; media.run = null; jobStatus('Cancelled.'); }
      else if (!event.ok && event.error) jobStatus(event.error);
      runNextMediaJob();
      break;
    }
    default: break;
  }
  renderQueue();
}

async function cancelMedia() {
  if (!media.job) return;
  media.job.cancelled = true;
  jobStatus('Cancelling - the file being rendered is discarded…');
  await window.api.mediaCancel();
}

// ---- desktop

async function loadMonitors() {
  const response = await window.api.mediaMonitors();
  if (!response.ok || !response.monitors.length) return;
  const select = $('#desktop-monitor');
  const keep = select.value;
  select.replaceChildren(element('option', null, 'Primary monitor'));
  select.options[0].value = '-1';
  for (const monitor of response.monitors) {
    const option = element('option', null, `${monitor.index + 1}: ${monitor.width}×${monitor.height}${monitor.primary ? ' (primary)' : ''}${monitor.hdr ? ' · HDR' : ''}`);
    option.value = String(monitor.index);
    select.appendChild(option);
  }
  select.value = [...select.options].some(option => option.value === keep) ? keep : '-1';
  if (media.settings) renderMediaSettings();
}

function renderDesktop() {
  const d = media.desktop;
  $('#desktop-start').hidden = d.running || d.starting;
  $('#desktop-stop').hidden = !(d.running || d.starting);
  // Everything else changes live; the monitor needs a restart.
  const monitor = $('#desktop-monitor');
  monitor.disabled = d.running || d.starting;
  monitor.title = monitor.disabled ? 'Stop desktop mode to pick another monitor' : '';
  const pill = $('#desktop-state');
  text(pill, d.starting ? 'starting' : d.running ? (d.visible ? 'on' : 'hidden') : 'off');
  pill.className = `pill${d.running ? (d.visible ? ' on' : ' warn') : ''}`;
  const rows = [];
  if (d.info) rows.push(specRow('Monitor', `${d.info.width}×${d.info.height}${d.info.hdr ? ' · HDR' : ''}`, 'on',
    `rendered at ${d.info.workWidth}×${d.info.workHeight}${d.info.motion ? ' · optical flow on' : ''}`));
  if (d.stats) {
    const s = d.stats;
    // The worker only renders when the picture really changes, so a still
    // desktop costs next to nothing; "updates" is how often it changed.
    const updates = Number.isFinite(s.updates) ? s.updates : s.fps;
    rows.push(specRow('Screen changes', `${updates.toFixed(1)} per second`, '',
      updates < 0.5 ? 'nothing on screen is changing - the last picture stays up' : null));
    rows.push(specRow('Rendered', `${s.fps.toFixed(1)} frames per second`, '',
      !d.visible ? 'hidden - Ctrl+Alt+N shows it again'
        : d.info && d.info.fpsCap && updates > s.fps + 5 ? `capped at ${d.info.fpsCap}` : null));
    // Timings from the last second that rendered anything (a still second has none).
    if (d.lastRender) rows.push(specRow('Neural rendering', `${d.lastRender.nrMs.toFixed(1)} ms per frame`, '', `whole frame on the GPU ${d.lastRender.gpuMs.toFixed(1)} ms`));
    if (d.lastLatency) rows.push(specRow('Capture to screen', `${d.lastLatency.toFixed(1)} ms`, '', null));
    if (d.info && d.info.hdr && Number.isFinite(s.sdrScale)) rows.push(specRow('SDR white', `${Math.round(s.sdrScale * 80)} nits`, '', 'from Windows HDR settings'));
  }
  $('#desktop-stats').replaceChildren(...rows);
}

async function startDesktop() {
  media.desktop = { running: false, starting: true, visible: true, stats: null, info: null, lastRender: null, lastLatency: null };
  renderDesktop();
  const response = await window.api.desktopStart(readMediaSettings());
  if (!response.ok) {
    media.desktop.starting = false;
    renderDesktop();
    toast(response.error);
    banner($('#media-readiness'), response.error);
    $('#media-readiness').className = 'banner warn';
  }
}

async function stopDesktop() { await window.api.desktopStop(); }

function onDesktopEvent(event) {
  const d = media.desktop;
  switch (event.event) {
    case 'desktop-ready': d.starting = false; d.running = true; d.info = event; toast('Desktop mode on - Ctrl+Alt+S splits before/after, Ctrl+Alt+N hides it, Ctrl+Alt+End stops'); break;
    case 'desktop-stats':
      d.stats = event;
      d.visible = event.visible;
      if (event.nrMs > 0) d.lastRender = { nrMs: event.nrMs, gpuMs: event.gpuMs };
      if (event.latencyMs > 0) d.lastLatency = event.latencyMs;
      break;
    case 'desktop-toggle': d.visible = event.visible; break;
    case 'desktop-split': $('#desktop-split').setAttribute('aria-checked', event.split ? 'true' : 'false'); break;
    case 'desktop-look':
      // The frame cap and working size change live too: keep the card in step.
      if (d.info) {
        if (Number.isFinite(event.fpsCap)) d.info.fpsCap = event.fpsCap;
        if (event.workWidth > 0 && event.workHeight > 0) { d.info.workWidth = event.workWidth; d.info.workHeight = event.workHeight; }
        if (typeof event.motion === 'boolean') d.info.motion = event.motion;
      }
      toast(`Look updated live - ${['Default', 'Natural', 'Cinematic'][event.style] || 'style ' + event.style}, ${event.passes} pass${event.passes === 1 ? '' : 'es'}`);
      break;
    case 'error': case 'crash':
      banner($('#media-readiness'), event.message || `The desktop worker crashed (${event.code} in ${event.module}).`);
      $('#media-readiness').className = 'banner warn';
      break;
    case 'exit': d.running = false; d.starting = false; d.stats = null; refreshReadiness(); break;
    default: break;
  }
  renderDesktop();
}

// ---- before / after

async function openCompare(item) {
  media.compare = item;
  const overlay = $('#media-compare');
  text($('#compare-title'), item.name);
  const [before, after] = await Promise.all([window.api.mediaPreview(item.source), window.api.mediaPreview(item.output)]);
  const make = (response, label) => {
    if (!response.ok) return element('div', 'compare-missing', `${label}: ${response.error}`);
    if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = response.url;
      video.muted = label === 'Original';
      video.loop = true;
      video.preload = 'auto';
      video.playsInline = true;
      return video;
    }
    const img = document.createElement('img');
    img.alt = label;
    img.src = response.url;
    img.addEventListener('error', () => img.replaceWith(element('div', 'compare-missing', `${label}: this format cannot be shown here`)));
    return img;
  };
  $('#compare-before').replaceChildren(make(before, 'Original'));
  $('#compare-after').replaceChildren(make(after, 'DLSS 5'));
  $('#compare-play').hidden = item.kind !== 'video';
  const info = item.info && item.info.width ? `${item.info.width}×${item.info.height}` : '';
  text($('#compare-meta'), [info, item.nrMs ? `NR ${item.nrMs.toFixed(1)} ms${item.kind === 'video' ? '/frame' : ''}` : '',
    Number.isFinite(item.change) ? `changed ${(item.change * 100).toFixed(1)}%` : ''].filter(Boolean).join(' · '));
  overlay.hidden = false;
  setCompareMode('wipe');
  applyWipe();
}

function compareVideos() {
  return [$('#compare-before').querySelector('video'), $('#compare-after').querySelector('video')].filter(Boolean);
}

function closeCompare() {
  compareVideos().forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
  $('#compare-before').replaceChildren();
  $('#compare-after').replaceChildren();
  $('#media-compare').hidden = true;
  media.compare = null;
}

function setCompareMode(mode) {
  $$('#compare-mode button').forEach(button => button.classList.toggle('is-on', button.dataset.mode === mode));
  const stage = $('#compare-stage');
  stage.dataset.mode = mode;
  $('#compare-slider').hidden = mode !== 'wipe';
  applyWipe();
}

function applyWipe() {
  const stage = $('#compare-stage');
  const mode = stage.dataset.mode || 'wipe';
  const after = $('#compare-after');
  if (mode === 'wipe') {
    const position = Number($('#compare-slider').value) / 10;
    after.style.clipPath = `inset(0 0 0 ${position}%)`;
    $('#compare-line').style.left = `${position}%`;
  } else {
    after.style.clipPath = '';
  }
}

// Keep the two videos on the same frame: the result follows the original.
function syncCompareVideos() {
  const [before, after] = compareVideos();
  if (!before || !after || before.paused) return;
  const drift = after.currentTime - before.currentTime;
  if (Math.abs(drift) > 0.25) after.currentTime = before.currentTime;
  else after.playbackRate = Math.abs(drift) > 0.03 ? (drift > 0 ? 0.95 : 1.05) : 1;
  requestAnimationFrame(syncCompareVideos);
}

function toggleComparePlay() {
  const videos = compareVideos();
  if (!videos.length) return;
  if (videos[0].paused) {
    Promise.all(videos.map(video => video.play().catch(() => {}))).then(() => requestAnimationFrame(syncCompareVideos));
    text($('#compare-play'), 'Pause');
  } else {
    videos.forEach(video => video.pause());
    text($('#compare-play'), 'Play');
  }
}

function wireMedia() {
  $$('#media-tabs button').forEach(button => button.addEventListener('click', () => setMediaTab(button.dataset.tab)));
  $('#media-add').addEventListener('click', async () => {
    const response = await window.api.mediaPickFiles();
    if (!response.ok) { toast(response.error); return; }
    if (response.files.length) addMediaFiles(response.files);
  });
  const zone = $('#media-drop');
  zone.addEventListener('dragenter', () => zone.classList.add('is-over'));
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-over'); });
  zone.addEventListener('drop', async event => {
    event.preventDefault();
    zone.classList.remove('is-over');
    const files = event.dataTransfer && event.dataTransfer.files;
    if (!files || !files.length) return;
    const response = await window.api.mediaAddDropped(files);
    if (!response.ok) { toast(response.error); return; }
    addMediaFiles(response.files);
  });
  $('#media-start').addEventListener('click', startMedia);
  $('#media-cancel').addEventListener('click', cancelMedia);
  $('#media-clear').addEventListener('click', () => {
    media.items = media.items.filter(item => item.status === 'queued' || item.status === 'running');
    renderQueue();
  });
  for (const id of ['#ms-style', '#ms-skin', '#ms-passes', '#ms-work', '#ms-codec', '#ms-quality', '#ms-audio', '#ms-format', '#desktop-fps', '#desktop-monitor']) {
    $(id).addEventListener('change', saveMediaSettingsSoon);
  }
  for (const id of ['#ms-mix', '#ms-intensity', '#ms-tone', '#ms-structure', '#ms-stabilize']) $(id).addEventListener('input', saveMediaSettingsSoon);
  for (const id of ['#ms-automask', '#ms-motion']) {
    $(id).addEventListener('click', () => {
      const node = $(id);
      node.setAttribute('aria-checked', node.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      saveMediaSettingsSoon();
    });
  }
  $('#desktop-split').addEventListener('click', async () => {
    const node = $('#desktop-split');
    const on = node.getAttribute('aria-checked') !== 'true';
    node.setAttribute('aria-checked', on ? 'true' : 'false');
    const response = await window.api.desktopSplit(on);
    if (response.ok && response.settings) media.settings = response.settings;
  });
  $('#media-reset').addEventListener('click', async () => {
    const defaults = await window.api.mediaGetSettings();
    if (!defaults.ok) return;
    const response = await window.api.mediaSetSettings({ ...defaults.defaults, outputDir: media.settings ? media.settings.outputDir : '' });
    if (response.ok) { media.settings = response.settings; renderMediaSettings(); toast('Look settings back to defaults'); }
  });
  $('#ms-outdir-pick').addEventListener('click', async () => {
    const response = await window.api.mediaPickOutputDir();
    if (response.ok && response.dir) { media.settings = response.settings; renderMediaSettings(); }
  });
  $('#ms-outdir-reset').addEventListener('click', async () => {
    const response = await window.api.mediaSetSettings({ outputDir: '' });
    if (response.ok) { media.settings = response.settings; renderMediaSettings(); }
  });
  $('#media-probe').addEventListener('click', async () => {
    const node = $('#media-probe-result');
    text(node, 'Starting the neural runtime on a test picture…');
    $('#media-probe').disabled = true;
    const response = await window.api.mediaProbe(readMediaSettings());
    $('#media-probe').disabled = false;
    if (response.ok) {
      text(node, `Working: ${response.ready ? response.ready.gpu : 'GPU'}${response.ready && response.ready.driver ? `, driver ${response.ready.driver}` : ''} - `
        + `a 256×256 test picture took ${response.probe.nrMs.toFixed(1)} ms of neural rendering and ${(response.probe.changedFraction * 100).toFixed(0)}% of it changed.`);
    } else {
      text(node, `Not working: ${(response.errors && response.errors[0]) || (response.probe && response.probe.message) || response.error || 'no answer from the worker'}`);
    }
  });
  $('#media-log').addEventListener('click', () => window.api.mediaReveal('log'));
  $('#desktop-start').addEventListener('click', startDesktop);
  $('#desktop-stop').addEventListener('click', stopDesktop);

  $('#compare-close').addEventListener('click', closeCompare);
  $('#media-compare').addEventListener('click', event => { if (event.target === $('#media-compare')) closeCompare(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#media-compare').hidden) closeCompare(); });
  $$('#compare-mode button').forEach(button => button.addEventListener('click', () => setCompareMode(button.dataset.mode)));
  $('#compare-slider').addEventListener('input', applyWipe);
  const stage = $('#compare-stage');
  stage.addEventListener('pointerdown', () => { if (stage.dataset.mode === 'flip') stage.classList.add('show-original'); });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) stage.addEventListener(type, () => stage.classList.remove('show-original'));
  $('#compare-play').addEventListener('click', toggleComparePlay);
  $('#compare-open').addEventListener('click', () => media.compare && window.api.mediaOpen(media.compare.output));
  $('#compare-reveal').addEventListener('click', () => media.compare && window.api.mediaReveal(media.compare.output));
  window.api.onMediaEvent(onMediaEvent);
  renderDesktop();
}

// ---------------------------------------------------------------- wiring

function wire() {
  $$('[data-view]').forEach(node => node.addEventListener('click', () => show(node.dataset.view)));

  $('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $$('#theme-seg button').forEach(button => button.addEventListener('click', () => setTheme(button.dataset.theme)));
  $('#artwork-switch').addEventListener('click', async () => {
    const next = $('#artwork-switch').getAttribute('aria-checked') !== 'true';
    const response = await window.api.setSettings({ fetchArtwork: next });
    if (response.ok) { state.settings = response.settings; $('#artwork-switch').setAttribute('aria-checked', next ? 'true' : 'false'); }
  });
  $('#unknown-runtime-switch').addEventListener('click', async () => {
    const next = !state.settings.allowUnknownRuntime;
    const response = await window.api.setSettings({ allowUnknownRuntime: next });
    if (response.ok) {
      state.settings = response.settings;
      $('#unknown-runtime-switch').setAttribute('aria-checked', next ? 'true' : 'false');
      if (state.current) refreshPlan();
    }
    if (next) { state.covers.clear(); renderLibrary(); renderRecent(); }
  });

  $('#win-min').addEventListener('click', () => window.api.windowControl('minimize'));
  $('#win-max').addEventListener('click', () => window.api.windowControl('maximize'));
  $('#win-close').addEventListener('click', () => window.api.windowControl('close'));
  window.api.onWindowState(({ maximized }) => { $('#win-max').title = maximized ? 'Restore' : 'Maximize'; });
  window.api.onActivity(appendActivity);

  // Home
  $('#home-browse').addEventListener('click', addFolder);
  $('#activity-copy').addEventListener('click', async () => {
    const response = await window.api.listActivity();
    if (!response.ok) return;
    const lines = response.entries.map(entry => `[${clockTime(entry.at)}] ${entry.level === 'info' ? '' : entry.level.toUpperCase() + ' '}${entry.message}`);
    await window.api.copyText(lines.join('\n'));
    toast('Activity copied');
  });
  $('#activity-clear').addEventListener('click', async () => { await window.api.clearActivity(); loadActivity(); });
  wireDrop();

  // Games
  $('#filter').addEventListener('input', () => { state.filters.text = $('#filter').value.trim().toLowerCase(); renderLibrary(); });
  $('#filter-api').addEventListener('change', () => { state.filters.api = $('#filter-api').value; renderLibrary(); });
  $('#filter-status').addEventListener('change', () => { state.filters.status = $('#filter-status').value; renderLibrary(); });
  $('#filter-clear').addEventListener('click', () => {
    state.filters = { text: '', api: '', status: '', store: state.filters.store, quick: new Set() };
    $('#filter').value = ''; $('#filter-api').value = ''; $('#filter-status').value = '';
    renderLibrary();
  });
  $$('#scope .scope-btn').forEach(button => button.addEventListener('click', () => {
    state.filters.store = button.dataset.store;
    $$('#scope .scope-btn').forEach(other => other.classList.toggle('is-on', other === button));
    renderLibrary();
  }));
  $('#rescan').addEventListener('click', loadLibrary);
  $('#add-folder').addEventListener('click', addFolder);
  $('#view-library').addEventListener('scroll', () => {
    $('#games-heading').classList.toggle('is-stuck', $('#view-library').scrollTop > 4);
  });

  // Sheet
  $('#back').addEventListener('click', closeGame);
  $('#view-game').addEventListener('click', event => { if (event.target === $('#view-game')) closeGame(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#view-game').hidden) closeGame(); });
  $('#exe-picker').addEventListener('change', refreshPlan);
  for (const id of ['#opt-passes', '#opt-model', '#opt-fg', '#opt-fgmult']) $(id).addEventListener('change', refreshPlan);
  $('#do-install').addEventListener('click', doInstall);
  $('#do-restore').addEventListener('click', doRestore);
  $('#verify-install').addEventListener('click', doVerify);
  $('#open-folder').addEventListener('click', () => state.current && window.api.openFolder(state.current.dir));
  $('#forget-folder').addEventListener('click', async () => {
    if (!state.current) return;
    const response = await window.api.forgetFolder(state.current.dir);
    if (!response.ok) { result(`Could not forget that folder: ${response.error}`); return; }
    closeGame();
    await loadLibrary();
  });

  // Runtimes, log, settings, about
  $('#browse-runtimes').addEventListener('click', browseRuntimes);
  $('#settings-add-runtime').addEventListener('click', browseRuntimes);
  $('#reload-log').addEventListener('click', loadLog);
  $('#open-covers').addEventListener('click', () => window.api.openFolder('covers'));
  $('#open-app').addEventListener('click', () => window.api.openFolder('app'));
  $('#open-payload').addEventListener('click', () => window.api.openFolder('payload'));
  $$('[data-link]').forEach(button => button.addEventListener('click', () => window.api.openLink(button.dataset.link)));
  wireMedia();
}

async function addFolder() {
  const response = await window.api.addFolder();
  if (!response.ok) { toast(response.error); return; }
  if (!response.added) return;
  toast(`Added ${response.game ? response.game.name : 'folder'}`);
  await loadLibrary();
  const game = state.games.find(item => item.dir === response.added);
  if (game) { show('library'); openGame(game); }
}

async function boot() {
  wire();
  wireUpdates();
  const info = await window.api.appInfo();
  if (info.ok) {
    state.info = info;
    state.settings = info.settings;
    applyTheme(info.settings.theme);
    text($('#status-sub'), `add-on build ${info.build}`);
    renderAbout(info);
    text($('#settings-app-root'), info.appRoot);
  }
  show('home');
  await loadUpdate();
  await loadLibrary();
  // The runtime line in the status card is the one thing that decides whether
  // any install can work, so it is checked once at start, quietly.
  await loadRuntimes();
}

document.addEventListener('DOMContentLoaded', boot);
