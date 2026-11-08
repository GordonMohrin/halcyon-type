// Split Keyboard for monkeytype — live Vial keyboard inside monkeytype.com.
// Runs in the page (extension content script with world MAIN, or userscript), so you
// type in the real monkeytype with your own account; this only adds the keyboard below
// the words. Styling follows monkeytype's keymap (theme colors, next-key highlight,
// 250 ms correct/error flash), see LICENSE (GPL-3.0) and monkeytype's Keymap.tsx.

import { HidTransport, VialKeyboard, findGrantedDevice, requestDevice, isRawHid, UNLOCK_COUNTER_MAX } from '../js/hid.js';
import { parseVialLayout, parseLayoutLabels, unpackLayoutOptions, placeKeys, keyBounds } from '../js/kle.js';
import { HOST_LAYOUTS, detectHostLayout, MOD_SYMBOLS, MOD_NAMES, KC_TRNS, KC_NO } from '../js/keycodes.js';
import { FirmwareModel, DomKeyTracker, lockedSnapshot } from '../js/state.js';
import { KeyboardView } from '../js/keyboard-view.js';
import { KeymapIndex } from '../js/lookup.js';
import { computeFingers, HandsView } from '../js/hands.js';

const DEMO_DATA = /*DEMO_DATA*/ null;
const CSS_TEXT = /*CSS_TEXT*/ '';
const POLL_MS = 12;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('halcyon.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('halcyon.' + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

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

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
};

class HalcyonMonkeytype {
  constructor() {
    this.ticker = makeTicker();
    this.source = 'none';
    this.kb = null;
    this.matrix = false;
    this.pollToken = 0;
    this.previewLayer = null;
    this.lastPressed = null;
    this.resolved = new Map(); // locked: DOM code -> key chosen when it went down
    this.prefs = {
      hints: true, hands: true, bar: true, hideMtKeymap: true, modules: false, size: 1, hostLayout: 'auto',
      ...store.get('prefs', {}),
    };
    this.dom = new DomKeyTracker(window);
    this.tabId = Math.random().toString(36).slice(2);
    this.channel = 'BroadcastChannel' in window ? new BroadcastChannel('halcyon-monkeytype') : null;
    this.#injectCss();
    this.#buildUi();
    this.#bind();
  }

  // ---------------------------------------------------------------- UI

  #injectCss() {
    if (!CSS_TEXT || document.getElementById('halcyon-mt-style')) return;
    const style = document.createElement('style');
    style.id = 'halcyon-mt-style';
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
  }

  #buildUi() {
    this.layersEl = h('div', { class: 'hmt-layers' });
    this.modsEl = h('div', { class: 'hmt-mods' });
    this.kbdEl = h('div', { class: 'hmt-kbd' });
    this.handsEl = h('div', { class: 'hmt-hands' });
    this.hintEl = h('div', { class: 'hmt-hint' });
    this.noticeEl = h('div', { class: 'hmt-notice' });
    this.panel = h('div', { id: 'halcyon-mt', class: 'hmt' },
      h('div', { class: 'hmt-bar' }, this.layersEl, this.modsEl),
      this.kbdEl, this.handsEl, this.hintEl, this.noticeEl);
    this.view = new KeyboardView(this.kbdEl, { fontScale: 0.78 });
    this.hands = new HandsView(this.handsEl);

    this.statusEl = h('span', { class: 'hmt-status' }, 'Split');
    this.menuEl = h('div', { class: 'hmt-menu', hidden: true });
    this.pill = h('div', { class: 'hmt-pill' },
      h('button', { class: 'hmt-pill-btn', title: 'Split Keyboard for monkeytype', onclick: (e) => { e.stopPropagation(); this.#toggleMenu(); } }, '⌨ ', this.statusEl),
      this.menuEl);
    document.body.appendChild(this.pill);
    document.addEventListener('click', (e) => { if (!this.menuEl.hidden && !this.pill.contains(e.target)) this.menuEl.hidden = true; });
    this.#applyPrefs();
  }

  #applyPrefs() {
    this.panel.style.setProperty('--hmt-scale', this.prefs.size);
    this.handsEl.hidden = !this.prefs.hands;
    this.panel.querySelector('.hmt-bar').hidden = !this.prefs.bar;
    document.body.classList.toggle('halcyon-hide-mt-keymap', !!(this.prefs.hideMtKeymap && this.kb));
    this.#updateHint();
  }

  #savePrefs() {
    store.set('prefs', this.prefs);
    this.#applyPrefs();
  }

  #toggleMenu() {
    this.menuEl.hidden = !this.menuEl.hidden;
    if (!this.menuEl.hidden) this.#renderMenu();
  }

  #renderMenu() {
    const m = this.menuEl;
    m.innerHTML = '';
    const row = (...c) => h('div', { class: 'hmt-menu-row' }, ...c);
    const btn = (label, fn, primary) => h('button', { class: 'hmt-btn' + (primary ? ' primary' : ''), onclick: async (e) => { e.stopPropagation(); await fn(); this.#renderMenu(); } }, label);
    const check = (key, label) => h('label', { class: 'hmt-check' },
      h('input', { type: 'checkbox', ...(this.prefs[key] ? { checked: true } : {}), onchange: (e) => {
        this.prefs[key] = e.target.checked;
        this.#savePrefs();
        if (key === 'modules' && this.kb) this.setupKeyboard(this.kbData);
      } }), label);

    m.append(h('div', { class: 'hmt-menu-title' }, this.kb ? this.kb.name : 'Split Keyboard for monkeytype'));
    m.append(h('div', { class: 'hmt-menu-status' }, this.#statusText()));
    const actions = row();
    if (!('hid' in navigator)) actions.append(h('span', { class: 'hmt-muted' }, 'Kein WebHID – Chrome/Edge nötig'));
    else if (this.source !== 'hid') actions.append(btn('Tastatur verbinden', () => this.connectClicked(), true));
    if (this.source === 'hid' && !this.vial?.unlocked) actions.append(btn('Entsperren', () => this.runUnlock(), true));
    if (this.source === 'hid' && this.vial?.unlocked) actions.append(btn('Sperren', () => this.lock()));
    if (this.source !== 'hid' && DEMO_DATA) actions.append(btn(this.source === 'demo' ? 'Demo schließen' : 'Demo', () => (this.source === 'demo' ? this.closeKeyboard() : this.loadDemo())));
    m.append(actions);

    const host = h('select', { onchange: (e) => { this.prefs.hostLayout = e.target.value; this.#savePrefs(); this.applyHostLayout(); } },
      ...[['auto', 'Automatisch'], ['de-mac', 'Deutsch (Mac)'], ['de-win', 'Deutsch (Windows/Linux)'], ['us', 'US']].map(([v, t]) =>
        h('option', { value: v, ...(this.prefs.hostLayout === v ? { selected: true } : {}) }, t)));
    m.append(row(h('span', {}, 'Systemlayout'), host));
    if (this.kb) {
      const base = h('select', { onchange: (e) => this.setBaseLayer(+e.target.value) },
        ...this.kb.usedLayers.map((u, i) => (u ? h('option', { value: i, ...(i === this.model.defaultLayer ? { selected: true } : {}) }, `Layer ${i}`) : null)).filter(Boolean));
      m.append(row(h('span', {}, 'Basis-Layer'), base));
    }
    m.append(check('hints', 'Nächste Taste markieren'), check('hands', 'Hände anzeigen'), check('bar', 'Layer- und Modifier-Leiste'),
      check('modules', 'Encoder & Module zeigen'), check('hideMtKeymap', 'monkeytype-Keymap ausblenden'));
    const learned = this.kb ? Object.keys(this.kb.preferred).length : 0;
    if (learned) {
      m.append(row(h('span', { class: 'hmt-muted', title: 'Zeichen, die auf mehreren Tasten liegen: gezeigt wird der Weg, den du zuletzt benutzt hast.' },
        `${learned} bevorzugte Tasten gemerkt`), btn('Vergessen', () => this.#forgetPreferred())));
    }
    const size = h('input', { type: 'range', min: '0.6', max: '1.5', step: '0.05', value: String(this.prefs.size),
      oninput: (e) => { this.prefs.size = +e.target.value; this.#savePrefs(); } });
    m.append(row(h('span', {}, 'Größe'), size));
  }

  #statusText() {
    if (this.source === 'none') return 'Keine Tastatur verbunden';
    if (this.source === 'demo') return 'Demo (Halcyon Kyria)';
    const keymap = `Keymap (${this.kb?.usedLayers.filter(Boolean).length} Layer) direkt aus der Tastatur gelesen, dafür ist kein Entsperren nötig.`;
    if (this.matrix) return 'Live – jede Taste, Layer und Modifier. ' + keymap;
    return 'Gesperrt – Layer-Tasten sieht die App erst nach dem Entsperren (gilt bis zum Abstecken). '
      + 'Ein Layer erscheint, sobald eine Taste darauf tippt. ' + keymap;
  }

  #updateStatus() {
    const short = this.source === 'none' ? 'Split' : this.source === 'demo' ? 'Demo' : this.matrix ? 'live' : 'gesperrt';
    this.statusEl.textContent = short;
    this.pill.dataset.state = this.source === 'hid' ? (this.matrix ? 'live' : 'locked') : this.source;
    this.#renderNotice();
    if (!this.menuEl.hidden) this.#renderMenu();
  }

  #renderNotice(progress) {
    const n = this.noticeEl;
    n.innerHTML = '';
    if (this.unlocking) {
      const names = this.vial.unlockKeys.map(([r, c]) => this.#keyLabelAt(r, c)).join(' + ');
      n.append(h('div', {}, `Halte ${names} gedrückt, bis der Balken voll ist (ca. 6 s). monkeytype bekommt solange keine Eingaben.`),
        h('div', { class: 'hmt-progress' }, h('div', { style: `width:${progress || 0}%` })),
        h('button', { class: 'hmt-btn', onclick: () => { this.unlocking = null; } }, 'Abbrechen'));
      return;
    }
    if (this.source === 'hid' && !this.matrix && !store.get('unlockDismissed', false)) {
      n.append(h('span', {}, 'Gesperrt sieht die App Layer-Tasten nicht. Einmal entsperren gilt bis zum Abstecken.'),
        h('button', { class: 'hmt-btn primary', onclick: () => this.runUnlock() }, 'Entsperren'),
        h('button', { class: 'hmt-btn', onclick: () => { store.set('unlockDismissed', true); this.#renderNotice(); } }, 'Später'));
    }
  }

  #keyLabelAt(r, c) {
    const node = [...this.view.nodes.values()].find((n) => n.key.row === r && n.key.col === c);
    const label = (node?.label?.main || '').trim();
    return label ? `„${label}“` : `Taste ${r},${c}`;
  }

  // ---------------------------------------------------------------- placement in monkeytype

  #ensurePanel() {
    const anchor = document.getElementById('wordsWrapper');
    if (!anchor || !this.kb) {
      if (this.panel.isConnected && !this.kb) this.panel.remove();
      return;
    }
    const mtKeymap = anchor.parentElement?.querySelector(':scope > [data-ui-element="keymap"]');
    const after = mtKeymap || anchor;
    if (this.panel.parentElement !== after.parentElement || this.panel.previousElementSibling !== after) after.after(this.panel);
  }

  // ---------------------------------------------------------------- keyboard data

  setupKeyboard(data) {
    this.kbData = data;
    const def = data.definition;
    const options = parseLayoutLabels(def.layouts.labels);
    const choices = unpackLayoutOptions(data.layoutOptionsValue || 0, options);
    // Encoders and Halcyon-module keys are irrelevant for typing; hidden unless enabled.
    const allKeys = parseVialLayout(def);
    const placed = this.prefs.modules
      ? placeKeys(allKeys, choices)
      : placeKeys(allKeys.filter((k) => !k.encoder && k.layoutIndex === -1), []);
    const positions = [...new Set(placed.keys.filter((k) => !k.encoder).map((k) => k.row + ',' + k.col))];
    const keyX = new Map();
    for (const k of placed.keys) {
      if (k.encoder) continue;
      const b = keyBounds(k);
      keyX.set(k.row + ',' + k.col, (b.minX + b.maxX) / 2 + k.shiftX);
    }
    const ctx = { host: this.host, tapDances: data.tapDances || [], customKeycodes: def.customKeycodes || null };
    const { fingers, homing } = computeFingers(placed, def.matrix.rows);
    this.kb = {
      ...data, placed, positions, keyX, centerX: placed.width / 2, ctx, fingers, homing,
      preferred: store.get('paths.' + data.uid, {}),
      usedLayers: data.keymap.map((layer, i) => i === 0 || layer.some((row) => row.some((kc) => kc !== KC_TRNS && kc !== KC_NO))),
    };
    this.model = new FirmwareModel(data.keymap, data.settings, data.tapDances);
    const base = store.get('base.' + data.uid, 0);
    this.model.defaultLayer = base < data.layerCount ? base : 0;
    this.index = new KeymapIndex(this.kb, this.host, this.model.defaultLayer);
    this.view.setKeyboard({ placed, keymap: data.keymap, encoders: data.encoders, ctx });
    this.view.setHoming(homing);
    this.lastHintChar = undefined;
    this.#renderLayerChips(true);
    this.#applyPrefs();
    this.#ensurePanel();
    this.render();
    this.#updateHint();
    this.#updateStatus();
  }

  closeKeyboard() {
    this.stopPolling();
    this.kb = null;
    this.source = 'none';
    this.panel.remove();
    this.#applyPrefs();
    this.#updateStatus();
  }

  async applyHostLayout() {
    const id = this.prefs.hostLayout === 'auto' ? await detectHostLayout() : this.prefs.hostLayout;
    this.host = HOST_LAYOUTS[id] || HOST_LAYOUTS.us;
    if (this.kb) {
      this.kb.ctx.host = this.host;
      this.index = new KeymapIndex(this.kb, this.host, this.model.defaultLayer);
      this.view.setLayer(this.view.layer, this.view.mask, this.view.live, true);
      this.lastHintChar = undefined;
      this.#updateHint();
    }
  }

  setBaseLayer(l) {
    this.model.defaultLayer = l;
    store.set('base.' + this.kb.uid, l);
    this.index = new KeymapIndex(this.kb, this.host, l);
    this.lastHintChar = undefined;
    this.render();
    this.#updateHint();
  }

  // ---------------------------------------------------------------- device

  async connect(device) {
    if (this.device === device && this.source === 'hid') return;
    await this.disconnect();
    this.channel?.postMessage({ type: 'claim', from: this.tabId });
    try {
      const transport = new HidTransport(device);
      await transport.open();
      const vial = new VialKeyboard(transport, device.productName || 'Tastatur');
      this.statusEl.textContent = 'lädt …';
      await vial.load((f, what) => {
        this.statusEl.textContent = what?.startsWith('Entsperren') ? what : `lädt ${Math.round(f * 100)} %`;
      });
      Object.assign(this, { device, transport, vial, source: 'hid' });
      this.setupKeyboard({
        name: vial.name, uid: vial.uid, definition: vial.definition, keymap: vial.keymap, layerCount: vial.layerCount,
        encoders: vial.encoders, settings: vial.settings, tapDances: vial.tapDances, layoutOptionsValue: vial.layoutOptionsValue,
      });
      this.#pollForState();
      this.#updateStatus();
    } catch (err) {
      console.error('[halcyon]', err);
      this.statusEl.textContent = 'Fehler';
      this.pill.title = err.message;
      try { await device.close(); } catch { /* ignore */ }
    }
  }

  async disconnect() {
    this.stopPolling();
    if (this.transport) await this.transport.close();
    this.transport = this.vial = this.device = null;
    if (this.source === 'hid') this.closeKeyboard();
  }

  async connectClicked() {
    try {
      const device = await requestDevice();
      if (device) await this.connect(device);
    } catch (err) {
      if (err.name !== 'NotFoundError') console.error('[halcyon]', err);
    }
  }

  async loadDemo() {
    await this.disconnect();
    this.source = 'demo';
    this.setupKeyboard(DEMO_DATA);
  }

  #pollForState() {
    if (this.vial?.unlocked) this.startPolling();
    else this.stopPolling();
  }

  #pollLoop(step) {
    const token = ++this.pollToken;
    let failures = 0;
    (async () => {
      while (this.pollToken === token) {
        const t0 = performance.now();
        try {
          await step(() => this.pollToken === token);
          failures = 0;
        } catch (err) {
          if (this.pollToken !== token) return;
          if (++failures > 8) { this.stopPolling(); this.#updateStatus(); return; }
        }
        await this.ticker.wait(Math.max(1, POLL_MS - (performance.now() - t0)));
      }
    })();
  }

  startPolling() {
    this.stopPolling();
    this.matrix = true;
    this.#pollLoop(async (current) => {
      const pressed = await this.vial.matrixPoll();
      if (!current()) return;
      const before = new Set(this.model.held.keys());
      if (this.model.update(pressed, performance.now())) {
        let learned = false;
        for (const p of pressed) {
          if (before.has(p)) continue;
          this.lastPressed = p;
          const rec = this.model.held.get(p);
          if (rec?.role === 'active') learned = this.index.learnPress(p, rec.layer, this.model.heldMods(p)) || learned;
        }
        if (learned) this.#savePreferred();
        this.render();
      }
    });
    this.#updateStatus();
  }

  stopPolling() {
    this.pollToken++;
    this.matrix = false;
    this.model?.update([], performance.now());
  }

  async lock() {
    this.stopPolling();
    await this.vial.lock();
    store.set('unlockDismissed', false);
    this.#pollForState();
    this.render();
    this.#updateStatus();
  }

  async runUnlock() {
    const vial = this.vial;
    if (!vial || this.unlocking) return;
    await vial.refreshUnlockStatus();
    if (vial.unlocked) { this.startPolling(); return; }
    this.stopPolling(); // the firmware answers nothing else while unlocking
    // Holding the unlock keys would type into the test: swallow keys while unlocking.
    const block = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    for (const t of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input']) window.addEventListener(t, block, true);
    document.activeElement?.blur?.();
    const token = {};
    this.unlocking = token;
    this.view.setUnlockKeys(vial.unlockKeys);
    this.#renderNotice(0);
    try {
      await vial.unlockStart();
      while (this.unlocking === token) {
        await this.ticker.wait(130); // firmware resets its counter if polled faster than every 100 ms
        if (this.unlocking !== token) break;
        const res = await vial.unlockPoll();
        this.#renderNotice(Math.round((1 - res.counter / UNLOCK_COUNTER_MAX) * 100));
        if (res.unlocked) break;
      }
    } catch (err) {
      console.error('[halcyon]', err);
    } finally {
      for (const t of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input']) window.removeEventListener(t, block, true);
      this.unlocking = null;
      this.view.setUnlockKeys(null);
    }
    this.#pollForState();
    this.#updateStatus();
  }

  // ---------------------------------------------------------------- live state

  render() {
    if (!this.kb) return;
    const snap = this.matrix ? this.model.snapshot()
      : lockedSnapshot({ dom: this.dom, index: this.index, viewLayer: this.view.layer, baseLayer: this.model.defaultLayer, resolved: this.resolved });
    this.snap = snap;
    const layer = this.previewLayer ?? snap.displayLayer;
    const mask = snap.activeMask | (1 << snap.defaultLayer) | (1 << layer);
    const mods = snap.mods | snap.oneShotMods | this.dom.mods;
    this.view.setLayer(layer, mask, { mods, caps: snap.capsWord || this.dom.capsLock || snap.capsLock });
    this.view.setPressed(snap.keys);
    this.#renderMods(snap.mods | this.dom.mods, snap.oneShotMods, this.dom.capsLock || snap.capsLock, snap.capsWord);
    this.#renderLayerChips(false, snap.activeMask, layer, snap.defaultLayer);
  }

  #renderMods(mods, oneShot, caps, capsWord) {
    const defs = [['shift', 0x02, MOD_SYMBOLS.shift, MOD_NAMES.shift], ['ctrl', 0x01, MOD_SYMBOLS.ctrl, MOD_NAMES.ctrl],
      ['alt', 0x04, MOD_SYMBOLS.alt, MOD_NAMES.alt], ['gui', 0x08, MOD_SYMBOLS.gui, MOD_NAMES.gui]];
    if (!this.modsEl.childElementCount) {
      for (const [id, , sym, name] of defs) this.modsEl.append(h('span', { class: 'hmt-mod', 'data-mod': id, title: name }, sym));
      this.modsEl.append(h('span', { class: 'hmt-mod', 'data-mod': 'caps', title: 'Caps Lock / Caps Word' }, '⇪'));
    }
    for (const [id, bit] of defs) {
      const el = this.modsEl.querySelector(`[data-mod="${id}"]`);
      const on = !!(mods & (bit | (bit << 4)));
      el.classList.toggle('on', on);
      el.classList.toggle('oneshot', !on && !!(oneShot & (bit | (bit << 4))));
    }
    this.modsEl.querySelector('[data-mod="caps"]').classList.toggle('on', !!(caps || capsWord));
  }

  #renderLayerChips(rebuild, mask = 1, shown = 0, base = 0) {
    if (rebuild) {
      this.layersEl.innerHTML = '';
      this.kb.usedLayers.forEach((used, i) => {
        if (!used) return;
        this.layersEl.append(h('button', {
          class: 'hmt-layer', 'data-layer': i, title: 'Klick: Layer festhalten',
          onclick: () => { this.previewLayer = this.previewLayer === i ? null : i; this.render(); },
        }, String(i)));
      });
    }
    for (const chip of this.layersEl.children) {
      const i = +chip.dataset.layer;
      chip.classList.toggle('active', !!(mask & (1 << i)));
      chip.classList.toggle('shown', i === shown);
      chip.classList.toggle('base', i === base);
      chip.classList.toggle('pinned', this.previewLayer === i);
    }
  }

  // ---------------------------------------------------------------- monkeytype words -> next key

  #nextChar() {
    const word = document.querySelector('#words .word.active');
    if (!word) return null;
    const letters = [...word.querySelectorAll('letter')];
    if (letters.some((l) => l.classList.contains('incorrect'))) return '\b';
    const next = letters.find((l) => !l.classList.contains('correct'));
    if (next) return next.textContent;
    let sib = word.nextElementSibling;
    while (sib && !sib.classList.contains('word')) sib = sib.nextElementSibling;
    return sib ? ' ' : null;
  }

  #countLetters() {
    const word = document.querySelector('#words .word.active');
    const all = document.querySelectorAll('#words letter.correct, #words letter.incorrect');
    let bad = 0;
    for (const l of all) if (l.classList.contains('incorrect')) bad++;
    return { index: word?.dataset.wordindex ?? null, total: all.length, bad };
  }

  #onWordsChanged() {
    // monkeytype "react" flash: the key just pressed lights up green-ish (main) or red (error)
    const c = this.#countLetters();
    if (this.lastCount && c.index === this.lastCount.index && c.total > this.lastCount.total && this.lastPressed) {
      this.view.flash(this.lastPressed, c.bad > this.lastCount.bad ? 'err' : 'ok');
    }
    this.lastCount = c;
    this.#updateHint();
  }

  #updateHint() {
    if (!this.kb) return;
    const ch = this.prefs.hints ? this.#nextChar() : null;
    if (ch === this.lastHintChar && this.lastHintBase === this.model.defaultLayer && this.lastHintHost === this.host) return;
    this.lastHintChar = ch; this.lastHintBase = this.model.defaultLayer; this.lastHintHost = this.host;
    const path = ch !== null ? this.index.pathFor(ch) : null;
    if (!path) {
      this.view.setHint(null);
      this.hands.set(null);
      this.hintEl.textContent = ch !== null && ch !== undefined ? `„${ch}“ ist nicht in deiner Keymap` : '';
      return;
    }
    this.view.setHint({ target: path.target, layerKeys: path.layerKeys, modKeys: path.modKeys });
    const f = (pos) => this.kb.fingers.get(pos);
    this.hands.set({ target: f(path.target), layer: path.layerKeys.map(f), mod: path.modKeys.map(f) });
    const steps = [];
    if (path.layer !== this.model.defaultLayer) steps.push(`Layer ${path.layer} halten`);
    if (path.shift) steps.push(MOD_SYMBOLS.shift);
    if (path.alt) steps.push(MOD_SYMBOLS.alt);
    this.hintEl.textContent = steps.length ? steps.join(' + ') + ' + Taste' : '';
  }

  // ---------------------------------------------------------------- preferred keys

  #onKeydown(e) {
    if (this.matrix) return;
    const ch = e.key.length === 1 ? e.key : null;
    const expectedChar = this.#nextChar();
    const expected = expectedChar ? this.index.pathFor(expectedChar) : null;
    const hit = this.index.resolveTyped(e.code, ch, expected, [this.view.layer, this.model.defaultLayer]);
    if (!hit) return;
    this.resolved.set(e.code, hit);
    this.lastPressed = hit.pos;
  }

  #savePreferred() {
    store.set('paths.' + this.kb.uid, this.kb.preferred);
    this.lastHintChar = undefined;
    this.#updateHint();
  }

  #forgetPreferred() {
    this.kb.preferred = {};
    store.set('paths.' + this.kb.uid, {});
    this.lastHintChar = undefined;
    this.#updateHint();
  }

  // ---------------------------------------------------------------- events

  #bind() {
    this.dom.onChange((e) => {
      if (!e) this.resolved.clear();
      else if (e.type === 'keyup') this.resolved.delete(e.code);
      else if (e.type === 'keydown' && this.index) this.#onKeydown(e);
      this.render();
    });
    window.addEventListener('blur', () => this.render());
    const observer = new MutationObserver(() => {
      if (this.observeQueued) return;
      this.observeQueued = true;
      queueMicrotask(() => { this.observeQueued = false; this.#onWordsChanged(); });
    });
    let observed = null;
    setInterval(() => {
      this.#ensurePanel();
      const words = document.getElementById('words');
      if (words && words !== observed) {
        observer.disconnect();
        observer.observe(words, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        observed = words;
        this.#onWordsChanged();
      }
      if (this.matrix) this.model.tick(performance.now());
    }, 500);
    if ('hid' in navigator) {
      navigator.hid.addEventListener('connect', (e) => { if (this.source !== 'hid' && isRawHid(e.device)) this.connect(e.device); });
      navigator.hid.addEventListener('disconnect', (e) => { if (e.device === this.device) this.disconnect(); });
    }
    this.channel?.addEventListener('message', (e) => {
      if (e.data?.type === 'claim' && e.data.from !== this.tabId && this.source === 'hid') this.disconnect();
    });
  }

  async start() {
    await this.applyHostLayout();
    this.#updateStatus();
    const granted = await findGrantedDevice();
    if (granted) await this.connect(granted);
  }
}

if (!window.__halcyonMonkeytype) {
  const app = new HalcyonMonkeytype();
  window.__halcyonMonkeytype = app;
  app.start();
}
