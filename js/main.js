// App wiring: connection, unlock flow, live polling, keyboard panel, typing test.

import { HidTransport, VialKeyboard, findGrantedDevice, requestDevice, isRawHid, UNLOCK_COUNTER_MAX } from './hid.js';
import { parseVialLayout, parseLayoutLabels, unpackLayoutOptions, placeKeys, keyBounds } from './kle.js';
import { HOST_LAYOUTS, detectHostLayout, MOD_SYMBOLS, MOD_NAMES, KC_TRNS, KC_NO } from './keycodes.js';
import { FirmwareModel, DomKeyTracker, lockedSnapshot } from './state.js';
import { KeyboardView } from './keyboard-view.js';
import { KeymapIndex } from './lookup.js';
import { TypingTest } from './typing.js';

const $ = (sel, root = document) => root.querySelector(sel);
const POLL_MS = 12;
const params = new URLSearchParams(location.search);
const VIEW_ONLY = params.get('view') === 'keyboard';

// ------------------------------------------------------------------ storage

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('ht.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('ht.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

// ------------------------------------------------------------------ background-safe timer
// Timers in hidden tabs are throttled to 1/s; a worker's timers are not, so the
// matrix keeps updating while the keyboard floats over another window.

function makeTicker() {
  try {
    const src = 'onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);';
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const waiting = new Map();
    let next = 0;
    worker.onmessage = (e) => { const fn = waiting.get(e.data); waiting.delete(e.data); fn && fn(); };
    return { wait: (ms) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); worker.postMessage({ id, ms }); }) };
  } catch {
    return { wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  }
}
const ticker = makeTicker();

// ------------------------------------------------------------------ app state

const app = {
  source: 'none',        // none | hid | demo
  device: null,
  transport: null,
  vial: null,
  kb: null,              // normalized keyboard data
  model: null,
  index: null,
  matrix: false,         // live matrix polling active
  pollToken: 0,
  previewLayer: null,
  hint: null,
  hintsOn: store.get('hints', true),
  hostId: store.get('hostLayout', 'auto'),
  host: HOST_LAYOUTS.us,
  heat: null,
  lastResult: null,
};

const view = new KeyboardView($('#kbd'));
const dom = new DomKeyTracker(window);
const tabId = Math.random().toString(36).slice(2);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('halcyon-type') : null;

// ------------------------------------------------------------------ status / UI helpers

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

function show(el, on) {
  el.hidden = !on;
}

function kbName() {
  return app.kb ? app.kb.name : '';
}

function updateStatus() {
  if (app.source === 'none') {
    setStatus('Keine Tastatur verbunden', 'off');
  } else if (app.source === 'demo') {
    setStatus('Demo · ' + kbName(), 'demo');
  } else if (app.matrix) {
    setStatus(kbName() + ' · live', 'live');
  } else {
    setStatus(kbName() + ' · gesperrt (nur Fokus-Modus)', 'locked');
  }
  show($('#btn-connect'), app.source !== 'hid');
  show($('#unlock-banner'), app.source === 'hid' && !app.matrix && !app.vial?.unlocked && !store.get('unlockDismissed', false));
  show($('#btn-lock'), app.source === 'hid' && app.vial?.unlocked);
  show($('#kbd-empty'), !app.kb);
}

// ------------------------------------------------------------------ keyboard setup

function nonEmptyLayers(keymap) {
  return keymap.map((layer, i) => i === 0 || layer.some((row) => row.some((kc) => kc !== KC_TRNS && kc !== KC_NO)));
}

function setupKeyboard(data) {
  // data: { name, uid, definition, keymap, layerCount, encoders, settings, tapDances, layoutOptionsValue }
  const def = data.definition;
  const all = parseVialLayout(def);
  const options = parseLayoutLabels(def.layouts.labels);
  const choices = unpackLayoutOptions(data.layoutOptionsValue || 0, options);
  const placed = placeKeys(all, choices);
  const positions = [...new Set(placed.keys.filter((k) => !k.encoder).map((k) => k.row + ',' + k.col))];
  const keyX = new Map();
  for (const k of placed.keys) {
    if (k.encoder) continue;
    const b = keyBounds(k);
    keyX.set(k.row + ',' + k.col, (b.minX + b.maxX) / 2 + k.shiftX);
  }
  const ctx = { host: app.host, tapDances: data.tapDances || [], customKeycodes: def.customKeycodes || null };
  app.kb = {
    ...data, placed, positions, keyX, centerX: placed.width / 2, ctx, options, choices,
    usedLayers: nonEmptyLayers(data.keymap),
  };
  const base = store.get('base.' + data.uid, 0);
  app.model = new FirmwareModel(data.keymap, data.settings, data.tapDances);
  app.model.defaultLayer = base < data.layerCount ? base : 0;
  app.previewLayer = null;
  rebuildIndex();
  view.setKeyboard({ placed, keymap: data.keymap, encoders: data.encoders, ctx });
  renderLayerChips(true);
  renderSettingsPanel();
  render();
  updateStatus();
}

function rebuildIndex() {
  if (!app.kb) return;
  app.kb.ctx.host = app.host;
  app.index = new KeymapIndex(app.kb, app.host, app.model.defaultLayer);
}

async function applyHostLayout() {
  const id = app.hostId === 'auto' ? await detectHostLayout() : app.hostId;
  app.host = HOST_LAYOUTS[id] || HOST_LAYOUTS.us;
  $('#host-detected').textContent = app.hostId === 'auto' ? `(erkannt: ${app.host.name})` : '';
  if (app.kb) {
    rebuildIndex();
    view.setLayer(view.layer, view.mask, view.live, true);
    updateHint(app.lastExpect);
  }
}

// ------------------------------------------------------------------ device connection

async function connect(device) {
  if (app.device === device && app.source === 'hid') return;
  await disconnect();
  setStatus('Verbinde …', 'busy');
  channel?.postMessage({ type: 'claim', from: tabId });
  try {
    const transport = new HidTransport(device);
    await transport.open();
    const vial = new VialKeyboard(transport, device.productName || 'Tastatur');
    await vial.load((f, what) => setStatus(`Lese ${what} … ${Math.round(f * 100)} %`, 'busy'));
    app.device = device;
    app.transport = transport;
    app.vial = vial;
    app.source = 'hid';
    setupKeyboard({
      name: vial.name, uid: vial.uid, definition: vial.definition, keymap: vial.keymap, layerCount: vial.layerCount,
      encoders: vial.encoders, settings: vial.settings, tapDances: vial.tapDances, layoutOptionsValue: vial.layoutOptionsValue,
    });
    pollForState();
    updateStatus();
  } catch (err) {
    console.error(err);
    setStatus('Fehler: ' + err.message, 'error');
    try { await device.close(); } catch { /* ignore */ }
  }
}

async function disconnect(reason) {
  stopPolling();
  if (app.transport) await app.transport.close();
  app.transport = null;
  app.vial = null;
  app.device = null;
  if (app.source === 'hid') {
    app.source = 'none';
    app.kb = null;
    $('#kbd').innerHTML = '';
    $('#layers').innerHTML = '';
  }
  updateStatus();
  if (reason) setStatus(reason, 'off');
}

async function connectClicked() {
  if (!('hid' in navigator)) {
    alert('Dein Browser unterstützt kein WebHID. Bitte Chrome, Edge, Brave oder Arc verwenden.');
    return;
  }
  try {
    const device = await requestDevice();
    if (device) await connect(device);
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Fehler: ' + err.message, 'error');
  }
}

async function loadDemo() {
  await disconnect();
  const res = await fetch('demo/halcyon-kyria.json');
  const data = await res.json();
  app.source = 'demo';
  setupKeyboard(data);
}

// ------------------------------------------------------------------ live matrix polling

function pollForState() {
  if (app.vial?.unlocked) startPolling();
  else stopPolling();
}

function startPolling() {
  stopPolling();
  app.matrix = true;
  pollLoop(async (current) => {
    const pressed = await app.vial.matrixPoll();
    if (current() && app.model.update(pressed, performance.now())) render();
  });
  updateStatus();
}

function pollLoop(step) {
  const token = ++app.pollToken;
  let failures = 0;
  (async () => {
    while (app.pollToken === token) {
      const t0 = performance.now();
      try {
        await step(() => app.pollToken === token);
        failures = 0;
      } catch (err) {
        if (app.pollToken !== token) return;
        if (++failures > 8) {
          console.error(err);
          stopPolling();
          setStatus('Verbindung zur Tastatur verloren', 'error');
          return;
        }
      }
      await ticker.wait(Math.max(1, POLL_MS - (performance.now() - t0)));
    }
  })();
}

function stopPolling() {
  app.pollToken++;
  app.matrix = false;
  if (app.model) { app.model.update([], performance.now()); }
}

// ------------------------------------------------------------------ unlock flow

let unlockAbort = null;

async function runUnlock() {
  const vial = app.vial;
  if (!vial) return;
  const dlg = $('#unlock-dialog');
  const bar = $('#unlock-progress');
  const text = $('#unlock-text');
  await vial.refreshUnlockStatus();
  if (vial.unlocked) { startPolling(); return; }
  stopPolling(); // the firmware answers nothing else while unlocking
  view.setUnlockKeys(vial.unlockKeys);
  const names = vial.unlockKeys.map(([r, c]) => keyNameAt(r, c)).join(' + ');
  text.textContent = `Halte ${vial.unlockKeys.length > 1 ? 'gleichzeitig' : ''} ${names} gedrückt, bis der Balken voll ist (etwa 6 Sekunden). Die Tasten sind auf der Tastatur unten markiert.`;
  bar.style.width = '0%';
  dlg.hidden = false;
  const token = {};
  unlockAbort = token;
  try {
    await vial.unlockStart();
    while (unlockAbort === token) {
      await ticker.wait(130); // the firmware resets its counter if polled faster than every 100 ms
      if (unlockAbort !== token) break;
      const res = await vial.unlockPoll();
      bar.style.width = Math.round((1 - res.counter / UNLOCK_COUNTER_MAX) * 100) + '%';
      if (res.unlocked) {
        bar.style.width = '100%';
        await ticker.wait(250);
        break;
      }
    }
  } catch (err) {
    setStatus('Entsperren fehlgeschlagen: ' + err.message, 'error');
  }
  unlockAbort = null;
  dlg.hidden = true;
  view.setUnlockKeys(null);
  pollForState();
  updateStatus();
}

function keyNameAt(r, c) {
  const kc = app.kb?.keymap[app.model.defaultLayer]?.[r]?.[c];
  const node = [...view.nodes.values()].find((n) => n.key.row === r && n.key.col === c);
  const label = node?.label?.main || '';
  return label ? `„${label.trim() || '␣'}“` : `Taste ${r},${c}` + (kc === undefined ? '' : '');
}

// ------------------------------------------------------------------ rendering of live state

let lastSnap = null;

function render() {
  if (!app.kb) return;
  const snap = app.matrix ? app.model.snapshot()
    : lockedSnapshot({ dom, index: app.index, viewLayer: view.layer, baseLayer: app.model.defaultLayer });
  lastSnap = snap;
  const focused = document.hasFocus();
  const layer = app.previewLayer ?? snap.displayLayer;
  const mask = snap.activeMask | (1 << snap.defaultLayer) | (1 << layer);
  const liveMods = snap.mods | snap.oneShotMods | dom.mods;
  view.setLayer(layer, mask, { mods: liveMods, caps: snap.capsWord || (focused && dom.capsLock) || snap.capsLock });
  view.setPressed(snap.keys);
  // DomKeyTracker clears itself on blur, so its mods only ever reflect the focused window.
  renderMods(snap.mods | dom.mods, snap.oneShotMods, (focused && dom.capsLock) || snap.capsLock, snap.capsWord);
  renderLayerChips(false, snap.activeMask, layer, snap.defaultLayer, snap.oneShotLayer);
}

function renderMods(mods, oneShot, capsLock, capsWord) {
  const bar = $('#mods');
  const defs = [
    ['shift', 0x02, MOD_SYMBOLS.shift, MOD_NAMES.shift],
    ['ctrl', 0x01, MOD_SYMBOLS.ctrl, MOD_NAMES.ctrl],
    ['alt', 0x04, MOD_SYMBOLS.alt, MOD_NAMES.alt],
    ['gui', 0x08, MOD_SYMBOLS.gui, MOD_NAMES.gui],
  ];
  if (!bar.dataset.built) {
    bar.innerHTML = defs.map(([id, , sym, name]) =>
      `<div class="mod" data-mod="${id}"><span class="sym">${sym}</span><span class="name">${name}</span><span class="lr"><i class="l">L</i><i class="r">R</i></span></div>`).join('') +
      '<div class="mod" data-mod="caps"><span class="sym">⇪</span><span class="name">Caps Lock</span></div>' +
      '<div class="mod" data-mod="capsword"><span class="sym">Aa</span><span class="name">Caps Word</span></div>';
    bar.dataset.built = '1';
  }
  for (const [id, bit] of defs) {
    const el = bar.querySelector(`[data-mod="${id}"]`);
    const l = !!(mods & bit), r = !!(mods & (bit << 4));
    const os = !!(oneShot & (bit | (bit << 4)));
    el.classList.toggle('on', l || r);
    el.classList.toggle('oneshot', os && !(l || r));
    el.querySelector('.l').classList.toggle('on', l || !!(oneShot & bit));
    el.querySelector('.r').classList.toggle('on', r || !!(oneShot & (bit << 4)));
  }
  bar.querySelector('[data-mod="caps"]').classList.toggle('on', !!capsLock);
  bar.querySelector('[data-mod="capsword"]').classList.toggle('on', !!capsWord);
}

function layerName(i) {
  const names = store.get('names.' + app.kb.uid, {});
  return names[i] || 'Layer ' + i;
}

function renderLayerChips(rebuild, mask = 1, shown = 0, base = 0, oneShot = -1) {
  const wrap = $('#layers');
  if (!app.kb) { wrap.innerHTML = ''; return; }
  if (rebuild || wrap.childElementCount !== app.kb.usedLayers.filter(Boolean).length) {
    wrap.innerHTML = '';
    app.kb.usedLayers.forEach((used, i) => {
      if (!used) return;
      const chip = document.createElement('button');
      chip.className = 'layer-chip';
      chip.dataset.layer = i;
      chip.innerHTML = `<span class="num">${i}</span><span class="lname">${escapeHtml(layerName(i))}</span>`;
      chip.title = 'Klick: Layer anzeigen/festhalten · Doppelklick: umbenennen';
      chip.addEventListener('click', () => {
        app.previewLayer = app.previewLayer === i ? null : i;
        render();
      });
      chip.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const nameEl = chip.querySelector('.lname');
        nameEl.contentEditable = 'true';
        nameEl.focus();
        document.getSelection().selectAllChildren(nameEl);
        const done = () => {
          nameEl.contentEditable = 'false';
          const names = store.get('names.' + app.kb.uid, {});
          const v = nameEl.textContent.trim();
          if (v && v !== 'Layer ' + i) names[i] = v; else delete names[i];
          store.set('names.' + app.kb.uid, names);
          nameEl.textContent = layerName(i);
        };
        nameEl.addEventListener('blur', done, { once: true });
        nameEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); nameEl.blur(); } ev.stopPropagation(); });
      });
      wrap.appendChild(chip);
    });
  }
  for (const chip of wrap.children) {
    const i = +chip.dataset.layer;
    chip.classList.toggle('active', !!(mask & (1 << i)));
    chip.classList.toggle('shown', i === shown);
    chip.classList.toggle('base', i === base);
    chip.classList.toggle('oneshot', i === oneShot);
    chip.classList.toggle('pinned', app.previewLayer === i);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ------------------------------------------------------------------ hints & heatmap

function charName(ch) {
  return ch === ' ' ? 'Leertaste' : ch === '\b' ? 'Rücktaste' : `„${ch}“`;
}

function updateHint(ch) {
  app.lastExpect = ch;
  const out = $('#hint');
  if (!app.kb || !app.hintsOn || ch === null || ch === undefined) {
    view.setHint(null);
    out.textContent = '';
    return;
  }
  const path = app.index.pathFor(ch);
  if (!path) {
    view.setHint(null);
    out.innerHTML = `${escapeHtml(charName(ch))} <span class="muted">— nicht in deiner Keymap gefunden</span>`;
    return;
  }
  view.setHint({
    target: path.target, layerKeys: path.layerKeys, modKeys: path.modKeys,
    badge: ch === ' ' ? '␣' : ch === '\b' ? '⌫' : ch,
  });
  const steps = [];
  if (path.layer !== app.model.defaultLayer) steps.push(`<b>${escapeHtml(layerName(path.layer))}</b> halten`);
  if (path.shift) steps.push(`<b>${MOD_SYMBOLS.shift}</b>`);
  if (path.alt) steps.push(`<b>${MOD_SYMBOLS.alt}</b>`);
  out.innerHTML = `Nächstes Zeichen ${escapeHtml(charName(ch))}${steps.length ? ': ' + steps.join(' + ') + ' + Taste' : ''}`;
}

function showHeat(result) {
  if (!app.kb || !result) { view.setHeat(null); return; }
  const errors = new Map();
  for (const [ch, n] of result.errorsByChar) {
    const p = app.index.pathFor(ch);
    if (p) errors.set(p.target, (errors.get(p.target) || 0) + n);
  }
  const max = Math.max(1, ...errors.values());
  const heat = new Map([...errors].map(([pos, n]) => [pos, 0.25 + 0.75 * (n / max)]));
  view.setHeat(heat);
}

// ------------------------------------------------------------------ settings panel

function renderSettingsPanel() {
  const sel = $('#base-layer');
  sel.innerHTML = '';
  if (!app.kb) return;
  app.kb.usedLayers.forEach((used, i) => {
    if (!used) return;
    const o = document.createElement('option');
    o.value = i; o.textContent = `${i} – ${layerName(i)}`;
    if (i === app.model.defaultLayer) o.selected = true;
    sel.appendChild(o);
  });
  const info = $('#kb-info');
  const s = app.kb.settings || {};
  const opts = app.kb.options.map((o, i) => `${o.title}: ${o.choices[app.kb.choices[i]] ?? app.kb.choices[i]}`);
  info.innerHTML = [
    `<b>${escapeHtml(app.kb.name)}</b>`,
    `${app.kb.layerCount} Layer · Matrix ${app.kb.definition.matrix.rows}×${app.kb.definition.matrix.cols}`,
    `Tapping Term ${s.tappingTerm ?? 200} ms${s.permissiveHold ? ' · Permissive Hold' : ''}${s.holdOnOtherKeyPress ? ' · Hold on other key press' : ''}`,
    ...opts.map(escapeHtml),
  ].join('<br>');
}

// ------------------------------------------------------------------ typing test

const test = VIEW_ONLY ? null : new TypingTest(
  { box: $('#test'), words: $('#words'), caret: $('#caret'), input: $('#words-input'), status: $('#test-status') },
  {
    onExpect: (ch) => updateHint(ch),
    onStart: () => { view.setHeat(null); document.body.classList.add('typing'); },
    onFinish: (result) => showResult(result),
  },
);

function loadTestConfig() {
  return { mode: 'time', time: 30, words: 25, lang: 'de', punctuation: false, numbers: false, code: false, ...store.get('test', {}) };
}

function syncConfigBar(cfg) {
  for (const btn of document.querySelectorAll('#config [data-set]')) {
    const [key, raw] = btn.dataset.set.split(':');
    const val = raw === 'toggle' ? cfg[key] : isNaN(+raw) ? raw : +raw;
    btn.classList.toggle('on', raw === 'toggle' ? !!cfg[key] : cfg[key] === val);
  }
  $('#cfg-time').hidden = cfg.mode !== 'time';
  $('#cfg-words').hidden = cfg.mode !== 'words';
  for (const b of document.querySelectorAll('[data-set="punctuation:toggle"],[data-set="numbers:toggle"]')) b.classList.toggle('disabled', cfg.code);
}

function setupConfigBar() {
  const cfg = loadTestConfig();
  syncConfigBar(cfg);
  test.configure(cfg);
  $('#config').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-set]');
    if (!btn) return;
    const c = loadTestConfig();
    const [key, raw] = btn.dataset.set.split(':');
    c[key] = raw === 'toggle' ? !c[key] : isNaN(+raw) ? raw : +raw;
    store.set('test', c);
    syncConfigBar(c);
    hideResult();
    test.configure(c);
  });
}

function showResult(r) {
  document.body.classList.remove('typing');
  app.lastResult = r;
  const key = `${r.config.mode}-${r.config.mode === 'time' ? r.config.time : r.config.words}-${r.config.lang}-${r.config.code ? 'code' : (r.config.punctuation ? 'p' : '') + (r.config.numbers ? 'n' : '')}`;
  const bests = store.get('bests', {});
  const isBest = r.wpm > (bests[key] || 0) && r.acc >= 75 && r.time >= 5;
  if (isBest) { bests[key] = Math.round(r.wpm * 10) / 10; store.set('bests', bests); }
  const res = $('#result');
  $('#r-wpm').textContent = Math.round(r.wpm);
  $('#r-acc').textContent = Math.round(r.acc) + '%';
  $('#r-raw').textContent = Math.round(r.raw);
  $('#r-chars').textContent = `${r.chars.correct}/${r.chars.incorrect}/${r.chars.extra}/${r.chars.missed}`;
  $('#r-cons').textContent = Math.round(r.consistency) + '%';
  $('#r-time').textContent = Math.round(r.time) + 's';
  $('#r-best').hidden = !isBest;
  $('#r-type').textContent = describeConfig(r.config);
  drawChart($('#r-chart'), r.samples);
  const worst = [...r.errorsByChar].sort((a, b) => b[1] - a[1]).slice(0, 6);
  $('#r-worst').innerHTML = worst.length
    ? 'Häufigste Fehler: ' + worst.map(([ch, n]) => `<span class="kbdch">${escapeHtml(ch === ' ' ? '␣' : ch)}</span>×${n}`).join(' ')
    : 'Keine Fehler – sauber!';
  res.hidden = false;
  $('#test').hidden = true;
  showHeat(r);
}

function hideResult() {
  $('#result').hidden = true;
  $('#test').hidden = false;
  view.setHeat(null);
}

function describeConfig(c) {
  const parts = [c.mode === 'time' ? `Zeit ${c.time}s` : `${c.words} Wörter`, c.lang === 'de' ? 'Deutsch' : 'English'];
  if (c.code) parts.push('Code'); else { if (c.punctuation) parts.push('Satzzeichen'); if (c.numbers) parts.push('Zahlen'); }
  return parts.join(' · ');
}

function drawChart(svg, samples) {
  const W = 600, H = 160, P = 28;
  if (!samples.length) { svg.innerHTML = ''; return; }
  const maxT = Math.max(...samples.map((s) => s.t), 1);
  const maxY = Math.max(10, ...samples.map((s) => Math.max(s.wpm, s.raw))) * 1.1;
  const x = (t) => P + (t / maxT) * (W - P * 2);
  const y = (v) => H - P + 4 - (v / maxY) * (H - P * 1.5);
  const line = (key) => samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
  const grid = [0.25, 0.5, 0.75, 1].map((f) => {
    const v = Math.round(maxY * f / 1.1 / 10) * 10;
    return `<line x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}</text>`;
  }).join('');
  const errs = samples.filter((s) => s.errors).map((s) => `<text x="${x(s.t)}" y="${y(s.raw) - 6}" class="err" text-anchor="middle">×</text>`).join('');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `${grid}<path d="${line('raw')}" class="raw"/><path d="${line('wpm')}" class="wpm"/>${errs}` +
    `<text x="${W - P}" y="${H - 4}" class="axis" text-anchor="end">${Math.round(maxT)} s</text>`;
}

// ------------------------------------------------------------------ floating keyboard window

async function openFloating() {
  const panel = $('#kbd-panel');
  if ('documentPictureInPicture' in window) {
    const pip = await window.documentPictureInPicture.requestWindow({ width: Math.min(980, panel.offsetWidth + 40), height: panel.offsetHeight + 40 });
    for (const sheet of document.styleSheets) {
      try {
        const style = pip.document.createElement('style');
        style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        pip.document.head.appendChild(style);
      } catch {
        const link = pip.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        pip.document.head.appendChild(link);
      }
    }
    pip.document.title = 'Halcyon Type – Tastatur';
    pip.document.body.className = 'pip';
    const placeholder = document.createElement('div');
    placeholder.id = 'kbd-placeholder';
    placeholder.innerHTML = '<p>Die Tastatur ist im schwebenden Fenster. <button class="link" id="btn-unfloat">Zurückholen</button></p>';
    panel.replaceWith(placeholder);
    pip.document.body.appendChild(panel);
    document.body.classList.add('floating');
    $('#btn-unfloat', placeholder).addEventListener('click', () => pip.close());
    pip.addEventListener('pagehide', () => {
      placeholder.replaceWith(panel);
      document.body.classList.remove('floating');
    });
  } else {
    window.open('?view=keyboard', 'halcyon-type-kbd', 'popup,width=960,height=420');
  }
}

// ------------------------------------------------------------------ events

function bindEvents() {
  $('#btn-connect').addEventListener('click', connectClicked);
  $('#btn-demo').addEventListener('click', loadDemo);
  $('#btn-float').addEventListener('click', () => openFloating().catch((e) => setStatus('Fenster: ' + e.message, 'error')));
  $('#btn-unlock').addEventListener('click', runUnlock);
  $('#btn-unlock-later').addEventListener('click', () => { store.set('unlockDismissed', true); updateStatus(); });
  $('#btn-unlock-cancel').addEventListener('click', () => { unlockAbort = null; });
  $('#btn-lock').addEventListener('click', async () => {
    if (!app.vial) return;
    stopPolling();
    await app.vial.lock();
    store.set('unlockDismissed', false);
    pollForState();
    updateStatus();
    render();
  });
  $('#btn-settings').addEventListener('click', () => { $('#settings').hidden = !$('#settings').hidden; });
  document.addEventListener('click', (e) => {
    if (!$('#settings').hidden && !e.target.closest('#settings, #btn-settings')) $('#settings').hidden = true;
  });
  $('#host-layout').value = app.hostId;
  $('#host-layout').addEventListener('change', (e) => { app.hostId = e.target.value; store.set('hostLayout', app.hostId); applyHostLayout(); });
  $('#hints').checked = app.hintsOn;
  $('#hints').addEventListener('change', (e) => { app.hintsOn = e.target.checked; store.set('hints', app.hintsOn); updateHint(app.lastExpect); });
  $('#base-layer').addEventListener('change', (e) => {
    const l = +e.target.value;
    app.model.defaultLayer = l;
    store.set('base.' + app.kb.uid, l);
    rebuildIndex();
    render();
    updateHint(app.lastExpect);
    renderLayerChips(true);
  });
  $('#btn-again')?.addEventListener('click', () => { hideResult(); test.restart(); });
  $('#btn-heat')?.addEventListener('click', () => {
    if (view.heat) view.setHeat(null); else showHeat(app.lastResult);
  });
  window.addEventListener('keydown', (e) => {
    if (VIEW_ONLY) return;
    if (e.key === 'Tab' && !$('#result').hidden) { e.preventDefault(); hideResult(); test.restart(); }
  });

  dom.onChange(() => { if (!app.matrix) render(); else renderModsOnly(); });
  window.addEventListener('blur', () => render());
  window.addEventListener('focus', () => render());

  if ('hid' in navigator) {
    navigator.hid.addEventListener('connect', (e) => { if (app.source !== 'hid' && isRawHid(e.device)) connect(e.device); });
    navigator.hid.addEventListener('disconnect', (e) => { if (e.device === app.device) disconnect('Tastatur getrennt'); });
  }
  channel?.addEventListener('message', (e) => {
    if (e.data?.type === 'claim' && e.data.from !== tabId && app.source === 'hid') {
      disconnect('Tastatur wird in einem anderen Fenster verwendet');
    }
  });
  window.addEventListener('pagehide', () => { stopPolling(); });
}

function renderModsOnly() {
  if (!lastSnap) return;
  const focused = document.hasFocus();
  renderMods(lastSnap.mods | dom.mods, lastSnap.oneShotMods, (focused && dom.capsLock) || lastSnap.capsLock, lastSnap.capsWord);
}

// ------------------------------------------------------------------ boot

async function boot() {
  if (VIEW_ONLY) document.body.classList.add('view-only');
  bindEvents();
  await applyHostLayout();
  if (!VIEW_ONLY) setupConfigBar();
  updateStatus();
  if (!('hid' in navigator)) {
    setStatus('Kein WebHID in diesem Browser – nutze Chrome/Edge, oder probiere die Demo', 'error');
    $('#btn-connect').disabled = true;
    return;
  }
  const granted = await findGrantedDevice();
  if (granted) connect(granted);
  else if (params.get('demo') !== null) loadDemo();
}

boot();

// exposed for debugging / automated tests
window.HT = { app, view, dom, loadDemo, render, connect, get test() { return test; } };
