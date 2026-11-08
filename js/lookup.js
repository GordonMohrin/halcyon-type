// Reverse lookups over the keymap:
//  - which physical key (and layer / modifiers) types a given character -> hints & heatmap
//  - which physical key produced a DOM KeyboardEvent.code              -> fallback without matrix access

import { decode, charFor, tapKeycode, BASIC, MOD_KEYS, FN_MO13, FN_MO23 } from './keycodes.js';

/**
 * kb: { keymap, layerCount, positions: ["r,c", ...], keyX: Map(pos -> x center), centerX, ctx,
 *       preferred: { char: "layer:r,c" } — the way the user last typed a character that has several }
 */
export class KeymapIndex {
  constructor(kb, host, baseLayer = 0) {
    this.kb = kb;
    this.host = host;
    this.baseLayer = baseLayer;
    this.build();
  }

  build() {
    const { keymap, positions, ctx } = this.kb;
    const host = this.host;
    this.charPaths = new Map();
    this.layerKeys = new Map();   // layer -> [{pos, kind}]
    this.modKeys = { shift: [], alt: [] };

    const add = (ch, path) => {
      if (!ch) return;
      const list = this.charPaths.get(ch) || [];
      list.push(path);
      this.charPaths.set(ch, list);
    };

    for (let l = 0; l < keymap.length; l++) {
      for (const pos of positions) {
        const [r, c] = pos.split(',').map(Number);
        const kc = keymap[l][r]?.[c] ?? 0;
        const d = decode(kc);
        const tap = tapKeycode(kc, ctx);
        if (tap && !tap.mods && tap.base === 0x2A) add('\b', { pos, layer: l, shift: false, alt: false });
        if (tap) {
          if (tap.mods) {
            add(charFor(tap.base, tap.mods, host), { pos, layer: l, shift: false, alt: false, cost: 0 });
          } else {
            add(charFor(tap.base, 0, host), { pos, layer: l, shift: false, alt: false });
            add(charFor(tap.base, 0x02, host), { pos, layer: l, shift: true, alt: false });
            if (host.altMode !== 'none') {
              add(charFor(tap.base, host.altMode === 'altgr' ? 0x40 : 0x04, host), { pos, layer: l, shift: false, alt: true });
              add(charFor(tap.base, host.altMode === 'altgr' ? 0x60 : 0x06, host), { pos, layer: l, shift: true, alt: true });
            }
          }
        }
        // keys that activate layers / modifiers (looked up on the layer they live on)
        const layerOf = (t) => ['mo', 'layertap', 'tt', 'osl', 'layermod', 'tg'].includes(t) ? d.layer : -1;
        const target = layerOf(d.type);
        if (target >= 0) this.#push(this.layerKeys, target, { pos, from: l, kind: d.type });
        if (d.type === 'quantum' && (d.code === FN_MO13 || d.code === FN_MO23)) {
          this.#push(this.layerKeys, d.code === FN_MO13 ? 1 : 2, { pos, from: l, kind: 'mo' });
        }
        const m = d.type === 'basic' ? MOD_KEYS[d.base] || 0 : d.type === 'modtap' || d.type === 'osm' ? d.mods : 0;
        if (m & 0x22) this.modKeys.shift.push({ pos, from: l, kind: d.type });
        if (m & (host.altMode === 'altgr' ? 0x40 : 0x44)) this.modKeys.alt.push({ pos, from: l, kind: d.type });
      }
    }
  }

  #push(map, k, v) {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }

  #side(pos) {
    const x = this.kb.keyX.get(pos);
    return x === undefined ? 0 : x < this.kb.centerX ? -1 : 1;
  }

  /** Best key to reach a layer from the base layer: prefer momentary keys, then the opposite hand. */
  #layerAccess(layer, targetPos) {
    if (layer === this.baseLayer) return [];
    const options = (this.layerKeys.get(layer) || []).filter((o) => o.from === this.baseLayer);
    if (!options.length) return null;
    const rank = { mo: 0, layertap: 0, tt: 1, layermod: 1, osl: 2, tg: 3 };
    const side = this.#side(targetPos);
    options.sort((a, b) => (rank[a.kind] - rank[b.kind]) || ((this.#side(a.pos) === side) - (this.#side(b.pos) === side)));
    return [options[0].pos];
  }

  #modAccess(kind, layer, targetPos) {
    const list = this.modKeys[kind].filter((m) => m.from === this.baseLayer || m.from === layer);
    if (!list.length) return null;
    const side = this.#side(targetPos);
    list.sort((a, b) => ((this.#side(a.pos) === side) - (this.#side(b.pos) === side)) || (a.from === this.baseLayer ? -1 : 1));
    return [list[0].pos];
  }

  /** How to type a character: { target, layer, layerKeys, modKeys, shift, alt } or null. */
  pathFor(ch) {
    const list = this.charPaths.get(ch);
    if (!list) return null;
    let best = null;
    for (const p of list) {
      const layerKeys = this.#layerAccess(p.layer, p.pos);
      if (layerKeys === null) continue; // layer unreachable from the base layer
      const modKeys = [];
      let missing = false;
      if (p.shift) { const m = this.#modAccess('shift', p.layer, p.pos); if (m) modKeys.push(...m); else missing = true; }
      if (p.alt) { const m = this.#modAccess('alt', p.layer, p.pos); if (m) modKeys.push(...m); else missing = true; }
      if (missing) continue;
      const preferred = this.kb.preferred?.[ch] === p.layer + ':' + p.pos;
      const cost = (preferred ? -10 : 0) + (p.layer === this.baseLayer ? 0 : 2) + (p.shift ? 1 : 0) + (p.alt ? 1.5 : 0);
      if (!best || cost < best.cost) best = { target: p.pos, layer: p.layer, layerKeys, modKeys, shift: p.shift, alt: p.alt, cost };
    }
    return best;
  }

  /** KeyboardEvent.code the key at pos sends when tapped on layer. */
  codeAt(pos, layer) {
    const [r, c] = pos.split(',').map(Number);
    const tap = tapKeycode(this.kb.keymap[layer]?.[r]?.[c] ?? 0, this.kb.ctx);
    return tap ? BASIC.get(tap.base)?.code : undefined;
  }

  /** Characters with more than one way to type them. */
  isAmbiguous(ch) {
    const list = this.charPaths.get(ch);
    return !!list && new Set(list.map((p) => p.layer + ':' + p.pos)).size > 1;
  }

  /**
   * Unlocked: a key went down on layer with these modifiers held (from the matrix, so it works
   * whichever window has focus). Every character it types that has other ways too now prefers
   * this one. Returns true if a preference changed.
   */
  learnPress(pos, layer, mods) {
    if (!this.kb.preferred) return false;
    const shift = !!(mods & 0x22);
    const alt = !!(mods & (this.host.altMode === 'altgr' ? 0x40 : 0x44));
    const key = layer + ':' + pos;
    let changed = false;
    for (const [ch, list] of this.charPaths) {
      if (!list.some((p) => p.pos === pos && p.layer === layer && p.shift === shift && p.alt === alt)) continue;
      if (!this.isAmbiguous(ch) || this.kb.preferred[ch] === key) continue;
      this.kb.preferred[ch] = key;
      changed = true;
    }
    return changed;
  }

  /**
   * Locked: which key sent a DOM keydown. Prefers the key the hint showed for the expected
   * character, then the user's preferred way for the typed character, then the shown layer.
   */
  resolveTyped(code, ch, expected, preferLayers) {
    if (expected && this.codeAt(expected.target, expected.layer) === code) return { pos: expected.target, layer: expected.layer };
    const pref = ch && this.kb.preferred?.[ch];
    if (pref) {
      const [l, pos] = pref.split(':');
      if (this.codeAt(pos, +l) === code) return { pos, layer: +l };
    }
    return this.positionsForCode(code, preferLayers)[0] || null;
  }

  /**
   * DOM fallback: physical position(s) for a KeyboardEvent.code, preferring the shown layer.
   */
  positionsForCode(code, preferLayers) {
    const keymap = this.kb.keymap;
    const out = [];
    const layers = [...preferLayers, ...keymap.keys()].filter((v, i, a) => a.indexOf(v) === i);
    for (const l of layers) {
      for (const pos of this.kb.positions) {
        const [r, c] = pos.split(',').map(Number);
        const kc = keymap[l]?.[r]?.[c] ?? 0;
        const tap = tapKeycode(kc, this.kb.ctx);
        let hit = tap && BASIC.get(tap.base)?.code === code;
        const d = decode(kc);
        if (!hit && (d.type === 'modtap' || d.type === 'osm')) {
          // a home-row mod sends the modifier's code when held
          hit = Object.entries(MOD_KEYS).some(([hid, bit]) => (d.mods & bit) && BASIC.get(+hid).code === code);
        }
        if (hit) out.push({ pos, layer: l });
      }
      if (out.length) return out;
    }
    return out;
  }
}
