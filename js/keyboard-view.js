// SVG rendering of the physical keyboard with live state.

import { labelFor, KC_TRNS } from './keycodes.js';

const U = 60;      // pixels per key unit
const GAP = 4;     // gap between keys
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function fontSizeFor(text, w) {
  const len = [...text].length;
  const base = len <= 1 ? 22 : len === 2 ? 17 : len === 3 ? 14 : len <= 5 ? 11.5 : 9.5;
  return Math.min(base, base * (w / U) * 1.15);
}

export class KeyboardView {
  /** opts: { fontScale } */
  constructor(container, opts = {}) {
    this.container = container;
    this.fontScale = opts.fontScale ?? 1;
    this.keys = [];
    this.nodes = new Map();   // key.id -> { g, cap, main, sub, alt, key }
    this.byPos = new Map();   // "r,c" -> [key.id]
    this.layer = 0;
    this.labelCache = new Map();
    this.onKeyHover = null;
  }

  /**
   * kb: { placed: {keys,width,height}, keymap, encoders, ctx }
   */
  setKeyboard(kb) {
    this.kb = kb;
    this.container.innerHTML = '';
    this.nodes.clear();
    this.byPos.clear();
    const { keys, width, height } = kb.placed;
    this.keys = keys;
    const pad = 6;
    const svg = el('svg', {
      viewBox: `${-pad} ${-pad} ${width * U + pad * 2} ${height * U + pad * 2}`,
      class: 'kbd-svg', role: 'img', 'aria-label': 'Tastatur',
    });
    this.svg = svg;
    for (const key of keys) {
      const tx = key.shiftX * U, ty = key.shiftY * U;
      const transform = `translate(${tx} ${ty})` +
        (key.rotation_angle ? ` rotate(${key.rotation_angle} ${key.rotation_x * U} ${key.rotation_y * U})` : '');
      const g = el('g', { class: 'key' + (key.encoder ? ' encoder' : ''), transform }, svg);
      const x = key.x * U + GAP / 2, y = key.y * U + GAP / 2;
      const w = key.width * U - GAP, h = key.height * U - GAP;
      let cap;
      if (key.encoder) {
        const r = Math.min(w, h) / 2;
        cap = el('circle', { cx: x + w / 2, cy: y + h / 2, r, class: 'cap' }, g);
        el('text', { x: x + w / 2, y: y + h / 2 - r * 0.42, class: 'enc-dir' }, g).textContent = key.encoder.dir ? '↻' : '↺';
      } else {
        cap = el('rect', { x, y, width: w, height: h, rx: 7, class: 'cap' }, g);
        if (key.width2 !== key.width || key.height2 !== key.height || key.x2 || key.y2) {
          el('rect', {
            x: x + key.x2 * U, y: y + key.y2 * U, width: key.width2 * U - GAP, height: key.height2 * U - GAP, rx: 7, class: 'cap',
          }, g);
        }
        el('rect', { x: x + 6, y: y + h - 6, width: 0, height: 3, rx: 1.5, class: 'pending-bar' }, g);
        el('rect', { x: x + w / 2 - 7, y: y + h - 9, width: 14, height: 3, rx: 1.5, class: 'homing' }, g);
      }
      const main = el('text', { x: x + w / 2, y: y + h / 2 + (key.encoder ? 7 : 2), class: 'main' }, g);
      const sub = el('text', { x: x + 7, y: y + 13, class: 'sub' }, g);
      const alt = el('text', { x: x + w - 6, y: y + h - 7, class: 'alt' }, g);
      const badge = el('g', { class: 'badge' }, g);
      el('rect', { x: x + w - 20, y: y - 10, width: 26, height: 20, rx: 10 }, badge);
      el('text', { x: x + w - 7, y: y + 1 }, badge);
      const title = el('title', {}, g);
      const node = { g, cap, main, sub, alt, badge, title, key, x, y, w, h };
      this.nodes.set(key.id, node);
      if (!key.encoder) {
        const pos = key.row + ',' + key.col;
        if (!this.byPos.has(pos)) this.byPos.set(pos, []);
        this.byPos.get(pos).push(key.id);
      }
    }
    this.container.appendChild(svg);
    this.labelCache.clear();
    this.setLayer(this.layer, 1 << this.layer, this.live, true);
  }

  /** Positions with a homing bump (index-finger home keys), like monkeytype's keymap. */
  setHoming(positions) {
    this.homing = positions;
    this.setLayer(this.layer, this.mask, this.live, true); // rebuilds base classes incl. homing
    this.refresh();
  }

  /** Short flash after a keystroke (monkeytype "react" style): kind = 'ok' | 'err'. */
  flash(pos, kind) {
    for (const id of this.byPos.get(pos) || []) {
      const g = this.nodes.get(id).g;
      g.classList.remove('flash-ok', 'flash-err');
      g.getBoundingClientRect();
      g.classList.add(kind === 'err' ? 'flash-err' : 'flash-ok');
      clearTimeout(g._flashTimer);
      g._flashTimer = setTimeout(() => g.classList.remove('flash-ok', 'flash-err'), 260);
    }
  }

  /** Effective keycode at a position for display: transparent keys show what falls through. */
  effectiveKeycode(r, c, layer, mask) {
    const km = this.kb.keymap;
    const own = km[layer]?.[r]?.[c] ?? 0;
    if (own !== KC_TRNS) return { kc: own, through: false };
    for (let l = layer - 1; l >= 0; l--) {
      if (!(mask & (1 << l))) continue;
      const kc = km[l]?.[r]?.[c] ?? 0;
      if (kc !== KC_TRNS) return { kc, through: true };
    }
    const kc0 = km[0]?.[r]?.[c] ?? 0;
    return { kc: kc0 === KC_TRNS ? 0 : kc0, through: true };
  }

  /** live: { mods, caps } — labels show what keys type under the current modifiers. */
  setLayer(layer, mask, live = null, force = false) {
    if (!this.kb) return;
    const liveKey = live ? ((live.mods & 0xFF) | (live.caps ? 0x100 : 0)) : 0;
    if (!force && layer === this.layer && mask === this.mask && liveKey === this.liveKey) return;
    this.layer = layer;
    this.mask = mask;
    this.live = live;
    this.liveKey = liveKey;
    const ctx = this.kb.ctx;
    for (const node of this.nodes.values()) {
      const key = node.key;
      let label, through = false;
      if (key.encoder) {
        // encoder actions fall through transparent layers just like keys
        let kc = null;
        for (let l = layer; l >= 0; l--) {
          if (l !== layer && !(mask & (1 << l)) && l !== 0) continue;
          const pair = this.kb.encoders?.[l + ',' + key.encoder.index];
          if (pair && pair[key.encoder.dir] !== KC_TRNS) { kc = pair[key.encoder.dir]; through = l !== layer; break; }
        }
        label = kc !== null ? labelFor(kc, ctx, live) : { main: '', cls: 'k-none', desc: 'Encoder' };
      } else {
        const eff = this.effectiveKeycode(key.row, key.col, layer, mask);
        through = eff.through;
        label = labelFor(eff.kc, ctx, live);
      }
      this.#applyLabel(node, label, through);
    }
  }

  #applyLabel(node, label, through) {
    const main = label.main || '';
    const lines = main.split('\n');
    node.main.textContent = lines[0];
    node.main.style.fontSize = fontSizeFor(lines[0], node.w) * this.fontScale + 'px';
    if (label.dual) {
      node.sub.textContent = '';
      node.alt.textContent = label.sub || '';
    } else {
      node.sub.textContent = label.sub || '';
      node.alt.textContent = label.alt || '';
    }
    const homing = this.homing && !node.key.encoder && this.homing.has(node.key.row + ',' + node.key.col) ? 'homing-key' : '';
    node.baseClass = ['key', node.key.encoder ? 'encoder' : '', label.cls || '', through ? 'through' : '', homing].join(' ').trim();
    node.g.setAttribute('class', [node.baseClass, ...(node.state || [])].join(' ').trim());
    node.title.textContent = label.desc || '';
    node.label = label;
  }

  #setState(node, states) {
    node.state = states;
    const flash = ['flash-ok', 'flash-err'].filter((c) => node.g.classList.contains(c));
    node.g.setAttribute('class', [node.baseClass, ...states, ...flash].join(' '));
  }

  /** keys: Map("r,c" -> { role, downAt, term }) from FirmwareModel.snapshot() or DOM fallback. */
  setPressed(keys) {
    this.lastKeys = keys;
    for (const node of this.nodes.values()) {
      if (node.key.encoder) continue;
      const pos = node.key.row + ',' + node.key.col;
      const st = keys.get(pos);
      const states = [];
      if (st) {
        states.push('pressed');
        if (st.role === 'hold') states.push('hold');
        if (st.role === 'pending') states.push('pending');
      }
      if (this.hint) {
        if (this.hint.target === pos) states.push('hint');
        if (this.hint.layerKeys?.includes(pos)) states.push('hint-layer');
        if (this.hint.modKeys?.includes(pos)) states.push('hint-mod');
      }
      if (this.unlockKeys?.has(pos)) states.push('unlock');
      if (this.heat && this.heat.has(pos)) states.push('heat');
      const key = states.join(' ');
      if (key !== node.stateKey) {
        node.stateKey = key;
        this.#setState(node, states);
        if (st && st.role === 'pending') {
          const bar = node.g.querySelector('.pending-bar');
          if (bar) {
            const left = Math.max(0, st.term - (performance.now() - st.downAt));
            bar.style.transition = 'none';
            bar.setAttribute('width', 0);
            bar.getBoundingClientRect();
            bar.style.transition = `width ${left}ms linear`;
            bar.setAttribute('width', node.w - 12);
          }
        } else {
          const bar = node.g.querySelector('.pending-bar');
          if (bar) { bar.style.transition = 'none'; bar.setAttribute('width', 0); }
        }
      }
    }
  }

  /** hint: { target: "r,c", layerKeys: [...], modKeys: [...], char, badge } or null */
  setHint(hint) {
    for (const node of this.nodes.values()) node.badge.classList.remove('show');
    this.hint = hint;
    if (hint && hint.target && hint.badge) {
      for (const id of this.byPos.get(hint.target) || []) {
        const node = this.nodes.get(id);
        node.badge.querySelector('text').textContent = hint.badge;
        node.badge.classList.add('show');
      }
    }
    this.refresh();
  }

  setUnlockKeys(list) {
    this.unlockKeys = list && list.length ? new Set(list.map(([r, c]) => r + ',' + c)) : null;
    this.refresh();
  }

  /** heat: Map("r,c" -> 0..1) — error heatmap after a test; null clears it. */
  setHeat(heat) {
    this.heat = heat;
    for (const node of this.nodes.values()) {
      if (node.key.encoder) continue;
      const v = heat ? heat.get(node.key.row + ',' + node.key.col) : undefined;
      if (v !== undefined) node.g.style.setProperty('--heat', String(v));
      else node.g.style.removeProperty('--heat');
    }
    this.refresh();
  }

  /** Re-apply state classes (after hint/heat/unlock changes). */
  refresh() {
    for (const node of this.nodes.values()) node.stateKey = null;
    this.setPressed(this.lastKeys || new Map());
  }
}
