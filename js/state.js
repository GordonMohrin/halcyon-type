// Reconstructs what the firmware is doing (active layers, modifiers, one-shots,
// tap-vs-hold decisions) from the raw switch matrix and the keymap.
// QMK itself does not report its layer state over raw HID, so we replay the
// relevant parts of QMK's logic on the host. This drives the on-screen keyboard.

import { decode, MOD_KEYS, KC_TRNS, FN_MO13, FN_MO23, QK_CAPS_WORD_TOGGLE, QK_LAYER_LOCK } from './keycodes.js';

const CAPS_WORD_IDLE_MS = 5000;

function highestBit(mask) {
  return mask ? 31 - Math.clz32(mask) : 0;
}

function continuesCapsWord(hid) {
  return (hid >= 0x04 && hid <= 0x27) || hid === 0x2D || hid === 0x2A || hid === 0x4C || hid === 0x38;
}

export class FirmwareModel {
  /**
   * keymap[layer][row][col] -> keycode
   * settings: { tappingTerm, permissiveHold, holdOnOtherKeyPress, oneshotTimeout, tappingToggle }
   */
  constructor(keymap, settings = {}, tapDances = []) {
    this.keymap = keymap;
    this.settings = { tappingTerm: 200, permissiveHold: false, holdOnOtherKeyPress: false, oneshotTimeout: 0, tappingToggle: 5, ...settings };
    this.tapDances = tapDances || [];
    this.reset();
  }

  reset() {
    this.defaultLayer = this.defaultLayer || 0;
    this.toggled = 0;
    this.oneShotLayer = -1;
    this.oneShotMods = 0;
    this.oneShotAt = 0;
    this.capsWord = false;
    this.capsLock = false;
    this.lastActivity = 0;
    this.held = new Map();
    this.ttTaps = new Map();
    this.version = 0;
  }

  keycodeAt(layer, r, c) {
    return this.keymap[layer]?.[r]?.[c] ?? 0;
  }

  activeMask() {
    let mask = (1 << this.defaultLayer) | this.toggled;
    let tri = 0;
    for (const rec of this.held.values()) {
      if (rec.layerEffect >= 0) mask |= 1 << rec.layerEffect;
      if (rec.tri) tri |= rec.tri;
    }
    if (this.oneShotLayer >= 0) mask |= 1 << this.oneShotLayer;
    if (tri === 3) mask |= 1 << 3; // Lower + Upper -> Adjust (QMK tri-layer defaults 1/2/3)
    return mask;
  }

  /** QMK layer_switch_get_layer(): highest active layer whose action isn't transparent. */
  resolve(r, c, mask = this.activeMask()) {
    for (let l = this.keymap.length - 1; l >= 0; l--) {
      if (!(mask & (1 << l))) continue;
      const kc = this.keycodeAt(l, r, c);
      if (kc !== KC_TRNS) return { kc, layer: l };
    }
    return { kc: this.keycodeAt(0, r, c), layer: 0 };
  }

  /** Feed the current list of pressed "row,col" positions. Returns true if anything changed. */
  update(pressedList, now = performance.now()) {
    const before = this.version;
    const pressed = new Set(pressedList);
    for (const [pos, rec] of [...this.held]) {
      if (!pressed.has(pos)) this.#release(rec, now);
    }
    for (const pos of pressed) {
      if (!this.held.has(pos)) this.#press(pos, now);
    }
    this.tick(now);
    return this.version !== before;
  }

  tick(now = performance.now()) {
    for (const rec of this.held.values()) {
      if (rec.role === 'pending' && now - rec.downAt >= rec.term) this.#becomeHold(rec);
    }
    const s = this.settings;
    if (s.oneshotTimeout > 0 && (this.oneShotMods || this.oneShotLayer >= 0) && now - this.oneShotAt > s.oneshotTimeout) {
      this.oneShotMods = 0;
      this.oneShotLayer = -1;
      this.version++;
    }
    if (this.capsWord && now - this.lastActivity > CAPS_WORD_IDLE_MS) {
      this.capsWord = false;
      this.version++;
    }
  }

  #press(pos, now) {
    const [r, c] = pos.split(',').map(Number);
    // Another key went down: pending dual-role keys are now "interrupted". With
    // hold-on-other-key-press QMK decides them *before* processing this key.
    for (const other of this.held.values()) {
      other.interrupted = true;
      if (other.role === 'pending' && this.settings.holdOnOtherKeyPress) this.#becomeHold(other);
    }
    const { kc, layer } = this.resolve(r, c);
    const d = decode(kc);
    const rec = {
      pos, r, c, kc, layer, d, downAt: now, role: 'active', interrupted: false,
      layerEffect: -1, mods: 0, holdMods: 0, holdLayer: -1, term: this.settings.tappingTerm,
      oneShot: null, appliedOneShotMods: 0, tri: 0,
    };
    this.lastActivity = now;

    const consumeOneShot = () => {
      if (this.oneShotMods || this.oneShotLayer >= 0) {
        rec.appliedOneShotMods = this.oneShotMods;
        this.oneShotMods = 0;
        this.oneShotLayer = -1;
      }
    };
    const capsWordCheck = (hid) => {
      if (this.capsWord && !continuesCapsWord(hid)) this.capsWord = false;
    };

    switch (d.type) {
      case 'basic':
        if (MOD_KEYS[d.base]) {
          rec.mods = MOD_KEYS[d.base];
        } else {
          consumeOneShot();
          capsWordCheck(d.base);
          if (d.base === 0x39) this.capsLock = !this.capsLock;
        }
        break;
      case 'mods':
        rec.mods = d.mods;
        consumeOneShot();
        capsWordCheck(d.base);
        break;
      case 'modtap':
        rec.role = 'pending';
        rec.holdMods = d.mods;
        break;
      case 'layertap':
        rec.role = 'pending';
        rec.holdLayer = d.layer;
        break;
      case 'mo':
        rec.layerEffect = d.layer;
        break;
      case 'layermod':
        rec.layerEffect = d.layer;
        rec.mods = d.mods;
        break;
      case 'tg':
        this.toggled ^= 1 << d.layer;
        break;
      case 'to':
        this.toggled = d.layer === this.defaultLayer ? 0 : 1 << d.layer;
        this.oneShotLayer = -1;
        break;
      case 'df':
      case 'pdf':
        this.defaultLayer = d.layer;
        break;
      case 'osl':
        rec.layerEffect = d.layer;
        rec.oneShot = 'layer';
        break;
      case 'osm':
        rec.mods = d.mods;
        rec.oneShot = 'mods';
        break;
      case 'tt':
        rec.layerEffect = d.layer;
        rec.tt = true;
        break;
      case 'td': {
        const td = this.tapDances[d.index];
        if (td && td.onHold) {
          const h = decode(td.onHold);
          rec.role = 'pending';
          if (td.tappingTerm) rec.term = td.tappingTerm;
          if (h.type === 'basic' && MOD_KEYS[h.base]) rec.holdMods = MOD_KEYS[h.base];
          else if (h.type === 'modtap' || h.type === 'osm') rec.holdMods = h.mods;
          else if (h.type === 'mo' || h.type === 'layertap' || h.type === 'tt') rec.holdLayer = h.layer;
        } else {
          consumeOneShot();
        }
        break;
      }
      case 'quantum':
        if (d.code === FN_MO13) { rec.layerEffect = 1; rec.tri = 1; }
        else if (d.code === FN_MO23) { rec.layerEffect = 2; rec.tri = 2; }
        else if (d.code === QK_CAPS_WORD_TOGGLE) this.capsWord = !this.capsWord;
        else if (d.code === QK_LAYER_LOCK) {
          const top = highestBit(this.activeMask());
          if (top !== this.defaultLayer) this.toggled ^= 1 << top;
        }
        break;
      default:
        consumeOneShot();
    }
    this.held.set(pos, rec);
    this.version++;
  }

  #becomeHold(rec) {
    rec.role = 'hold';
    if (rec.holdMods) rec.mods = rec.holdMods;
    if (rec.holdLayer >= 0) {
      rec.layerEffect = rec.holdLayer;
      // QMK buffers keys pressed while a layer-tap is undecided and processes them
      // after the decision, i.e. on the new layer.
      const mask = this.activeMask();
      for (const other of this.held.values()) {
        if (other === rec || other.downAt < rec.downAt || other.role !== 'active') continue;
        const res = this.resolve(other.r, other.c, mask);
        other.kc = res.kc;
        other.layer = res.layer;
        other.d = decode(res.kc);
        if (other.d.type === 'basic' && MOD_KEYS[other.d.base]) other.mods = MOD_KEYS[other.d.base];
      }
    }
    this.version++;
  }

  #release(rec, now) {
    this.held.delete(rec.pos);
    this.lastActivity = now;
    const s = this.settings;

    if (rec.role === 'pending') {
      // Released before the tapping term: it was a tap.
      rec.role = 'tap';
      if (this.oneShotMods || this.oneShotLayer >= 0) { this.oneShotMods = 0; this.oneShotLayer = -1; }
      if (rec.d.base !== undefined && this.capsWord && !continuesCapsWord(rec.d.base)) this.capsWord = false;
    }

    // Permissive hold: a key pressed *and released* inside a pending dual-role key makes it a hold.
    if (s.permissiveHold) {
      for (const other of this.held.values()) {
        if (other.role === 'pending' && other.downAt <= rec.downAt) this.#becomeHold(other);
      }
    }

    if (rec.oneShot && !rec.interrupted) {
      if (rec.oneShot === 'mods') this.oneShotMods |= rec.mods;
      else this.oneShotLayer = rec.layerEffect;
      this.oneShotAt = now;
    }

    if (rec.tt && !rec.interrupted && now - rec.downAt < s.tappingTerm) {
      const prev = this.ttTaps.get(rec.d.layer);
      const count = prev && now - prev.at < s.tappingTerm * 2 ? prev.count + 1 : 1;
      if (count >= s.tappingToggle) {
        this.toggled ^= 1 << rec.d.layer;
        this.ttTaps.delete(rec.d.layer);
      } else {
        this.ttTaps.set(rec.d.layer, { count, at: now });
      }
    }
    this.version++;
  }

  /** Modifiers applying to the key at pos: held by other keys, plus one-shots it consumed (not its own, e.g. S(KC_1)). */
  heldMods(pos) {
    let mods = this.held.get(pos)?.appliedOneShotMods || 0;
    for (const rec of this.held.values()) if (rec.pos !== pos) mods |= rec.mods | rec.appliedOneShotMods;
    return mods;
  }

  /** Snapshot for rendering. */
  snapshot() {
    const mask = this.activeMask();
    let mods = 0;
    const keys = new Map();
    for (const rec of this.held.values()) {
      mods |= rec.mods | rec.appliedOneShotMods;
      keys.set(rec.pos, { role: rec.role, layer: rec.layer, kc: rec.kc, downAt: rec.downAt, term: rec.term });
    }
    return {
      activeMask: mask,
      displayLayer: highestBit(mask),
      defaultLayer: this.defaultLayer,
      mods,
      oneShotMods: this.oneShotMods,
      oneShotLayer: this.oneShotLayer,
      capsWord: this.capsWord,
      capsLock: this.capsLock,
      keys,
    };
  }
}

// ---------------------------------------------------------------------------
// Snapshot without matrix access (Vial locked): pressed keys come from DOM key events of the
// focused window. Layer keys send nothing, so a layer only shows once a key on it types.
// resolved: Map(code -> { pos, layer }) chosen when the key went down (see KeymapIndex.resolveTyped).

export function lockedSnapshot({ dom, index, viewLayer, baseLayer, resolved = new Map() }) {
  const keys = new Map();
  let shown = -1;
  for (const code of dom.codes) {
    const hit = resolved.get(code) || index.positionsForCode(code, [viewLayer, baseLayer])[0];
    if (!hit) continue;
    keys.set(hit.pos, { role: 'active' });
    if (hit.layer !== baseLayer && !/Shift|Control|Alt|Meta/.test(code)) shown = Math.max(shown, hit.layer);
  }
  return {
    activeMask: (1 << baseLayer) | (shown >= 0 ? 1 << shown : 0), displayLayer: shown >= 0 ? shown : baseLayer, defaultLayer: baseLayer,
    mods: 0, oneShotMods: 0, oneShotLayer: -1, capsWord: false, capsLock: dom.capsLock, keys,
  };
}

// ---------------------------------------------------------------------------
// OS-level modifier/key state from DOM keyboard events (only while focused).

const CODE_MODS = {
  ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08,
  ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80,
};

export class DomKeyTracker {
  constructor(target = window) {
    this.codes = new Set();
    this.mods = 0;
    this.capsLock = false;
    this.listeners = new Set();
    this.lastEvent = null;
    const onKey = (e) => {
      if (e.repeat) return;
      if (e.type === 'keydown') this.codes.add(e.code);
      else this.codes.delete(e.code);
      let m = 0;
      for (const code of this.codes) m |= CODE_MODS[code] || 0;
      // getModifierState catches mods pressed before focus; split L/R if unknown.
      if (e.getModifierState) {
        if (e.getModifierState('Shift') && !(m & 0x22)) m |= 0x02;
        if (e.getModifierState('Control') && !(m & 0x11)) m |= 0x01;
        if (e.getModifierState('Alt') && !(m & 0x44)) m |= 0x04;
        if (e.getModifierState('Meta') && !(m & 0x88)) m |= 0x08;
        if (!e.getModifierState('Shift')) m &= ~0x22;
        if (!e.getModifierState('Control')) m &= ~0x11;
        if (!e.getModifierState('Alt')) m &= ~0x44;
        if (!e.getModifierState('Meta')) m &= ~0x88;
        this.capsLock = e.getModifierState('CapsLock');
      }
      // macOS swallows keyup of other keys while Cmd is held: drop stale codes.
      if (e.type === 'keyup' && (e.code === 'MetaLeft' || e.code === 'MetaRight')) {
        for (const code of [...this.codes]) if (!CODE_MODS[code]) this.codes.delete(code);
      }
      this.mods = m;
      this.lastEvent = e;
      for (const fn of this.listeners) fn(e);
    };
    target.addEventListener('keydown', onKey, true);
    target.addEventListener('keyup', onKey, true);
    target.addEventListener('blur', () => {
      this.codes.clear();
      this.mods = 0;
      for (const fn of this.listeners) fn(null);
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
  }
}
