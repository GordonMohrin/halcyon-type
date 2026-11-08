// Vial / VIA raw-HID protocol over WebHID.
// Every request is a 32-byte output report; the firmware answers with one
// 32-byte input report. Requests are strictly serialized.

import { xzDecompress } from './xz.js';
import { parseVialLayout } from './kle.js';

export const RAW_HID_FILTER = { usagePage: 0xff60, usage: 0x61 };
const MSG_LEN = 32;

const VIA = { PROTOCOL_VERSION: 0x01, GET_KEYBOARD_VALUE: 0x02, LAYER_COUNT: 0x11, KEYMAP_GET_BUFFER: 0x12, VIAL_PREFIX: 0xfe };
const VIA_VALUE = { LAYOUT_OPTIONS: 0x02, SWITCH_MATRIX_STATE: 0x03 };
const VIA_UNHANDLED = 0xff;
const VIAL = {
  KEYBOARD_ID: 0x00, GET_SIZE: 0x01, GET_DEF: 0x02, GET_ENCODER: 0x03, UNLOCK_STATUS: 0x05, UNLOCK_START: 0x06,
  UNLOCK_POLL: 0x07, LOCK: 0x08, QMK_SETTINGS_GET: 0x0a, DYNAMIC_ENTRY_OP: 0x0d,
};
const QSID = { TAPPING_TERM: 7, OSK_TIMEOUT: 6, TAPPING_TOGGLE: 20, PERMISSIVE_HOLD: 22, HOLD_ON_OTHER_KEY_PRESS: 23 };

export const UNLOCK_COUNTER_MAX = 50;

export class HidTransport {
  constructor(device) {
    this.device = device;
    this.chain = Promise.resolve();
    this.waiter = null;
    this.onReport = (e) => {
      const view = e.data;
      const data = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
      if (this.waiter) this.waiter(data);
    };
    device.addEventListener('inputreport', this.onReport);
  }

  async open() {
    if (!this.device.opened) await this.device.open();
  }

  async close() {
    this.device.removeEventListener('inputreport', this.onReport);
    try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
  }

  /**
   * Send one request and wait for the answer.
   * echo: number of leading request bytes the answer must repeat (VIA commands echo, Vial ones don't).
   */
  request(bytes, { timeout = 600, retries = 3, echo = 0 } = {}) {
    const run = async () => {
      const buf = new Uint8Array(MSG_LEN);
      buf.set(bytes);
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await this.#exchange(buf, timeout, echo);
        } catch (err) {
          lastErr = err;
          if (err.fatal) break;
        }
      }
      throw lastErr;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  #exchange(buf, timeout, echo) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('The keyboard did not answer in time'));
      }, timeout);
      this.waiter = (data) => {
        for (let i = 0; i < echo; i++) if (data[i] !== buf[i]) return; // stray report, keep waiting
        clearTimeout(timer);
        this.waiter = null;
        resolve(data);
      };
      this.device.sendReport(0, buf).catch((err) => {
        clearTimeout(timer);
        this.waiter = null;
        err.fatal = true;
        reject(err);
      });
    });
  }
}

const le16 = (d, o) => d[o] | (d[o + 1] << 8);
const be16 = (d, o) => (d[o] << 8) | d[o + 1];
const le32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const be32 = (d, o) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

export class VialKeyboard {
  constructor(transport, name = 'Keyboard') {
    this.t = transport;
    this.name = name;
  }

  /**
   * Load everything needed for display. onProgress(fraction, text) is optional.
   * VIA firmware (no Vial) has no layout on board: pass its VIA definition JSON as viaDefinition,
   * otherwise load() throws an error with code 'needsDefinition'.
   */
  async load(onProgress = () => {}, { viaDefinition = null } = {}) {
    const t = this.t;
    onProgress(0.02, 'protocol');
    const via = await t.request([VIA.PROTOCOL_VERSION], { echo: 1 });
    this.viaProtocol = be16(via, 1);

    const id = await t.request([VIA.VIAL_PREFIX, VIAL.KEYBOARD_ID]);
    this.isVia = id[0] === VIA_UNHANDLED; // VIA answers the Vial prefix with id_unhandled
    if (this.isVia) {
      await this.#loadViaDefinition(viaDefinition);
    } else {
      this.vialProtocol = le32(id, 0);
      this.uid = [...id.slice(4, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (this.vialProtocol < 6) {
        console.warn('Vial protocol', this.vialProtocol, '< 6: keycodes may be labelled wrongly (old QMK keycode layout).');
      }
      await this.#loadVialDefinition(onProgress);
    }
    this.rows = this.definition.matrix.rows;
    this.cols = this.definition.matrix.cols;

    // An unlock left half-done (page reloaded while holding the keys) makes the firmware ignore
    // everything but unlock commands, so keymap reads would come back empty: finish it first.
    if (!this.isVia) {
      await this.refreshUnlockStatus();
      if (this.unlockInProgress) await this.#finishUnlock(onProgress);
    }

    this.layerCount = (await t.request([VIA.LAYER_COUNT], { echo: 1 }))[1];
    if (!this.layerCount) throw new Error('The keyboard returned no keymap. Please unplug it and plug it back in.');

    // Whole keymap buffer: layer -> row -> col, big-endian 16-bit keycodes.
    const total = this.layerCount * this.rows * this.cols * 2;
    const buf = new Uint8Array(total);
    for (let off = 0; off < total; off += 28) {
      const n = Math.min(28, total - off);
      const data = await t.request([VIA.KEYMAP_GET_BUFFER, off >> 8, off & 0xff, n], { echo: 3 });
      buf.set(data.slice(4, 4 + n), off);
      onProgress(0.5 + 0.35 * (off / total), 'keymap');
    }
    this.keymap = [];
    for (let l = 0; l < this.layerCount; l++) {
      const layer = [];
      for (let r = 0; r < this.rows; r++) {
        const row = [];
        for (let c = 0; c < this.cols; c++) row.push(be16(buf, ((l * this.rows + r) * this.cols + c) * 2));
        layer.push(row);
      }
      this.keymap.push(layer);
    }

    this.layoutOptionsValue = 0;
    if (this.definition.layouts.labels) {
      const data = await t.request([VIA.GET_KEYBOARD_VALUE, VIA_VALUE.LAYOUT_OPTIONS], { echo: 2 });
      this.layoutOptionsValue = be32(data, 2);
    }

    onProgress(0.88, 'encoders & settings');
    if (this.isVia) {
      // no Vial extras; VIA never locks the switch matrix
      Object.assign(this, { encoders: {}, tapDances: [], unlocked: true, unlockInProgress: false, unlockKeys: [] });
      this.settings = { tappingTerm: 200, permissiveHold: false, holdOnOtherKeyPress: false, oneshotTimeout: 0, tappingToggle: 5 };
      onProgress(1, 'done');
      return this;
    }
    await this.#loadEncoders();
    await this.#loadSettings();
    await this.#loadTapDances();
    await this.refreshUnlockStatus();
    onProgress(1, 'done');
    return this;
  }

  async #loadVialDefinition(onProgress) {
    const t = this.t;
    const sz = le32(await t.request([VIA.VIAL_PREFIX, VIAL.GET_SIZE]), 0);
    if (!sz || sz > 1 << 20) throw new Error('Invalid Vial definition size: ' + sz);
    const payload = new Uint8Array(sz);
    const blocks = Math.ceil(sz / MSG_LEN);
    for (let b = 0; b < blocks; b++) {
      const data = await t.request([VIA.VIAL_PREFIX, VIAL.GET_DEF, b & 0xff, (b >> 8) & 0xff, 0, 0]);
      payload.set(data.slice(0, Math.min(MSG_LEN, sz - b * MSG_LEN)), b * MSG_LEN);
      if (b % 8 === 0) onProgress(0.05 + 0.45 * (b / blocks), 'layout definition');
    }
    this.definition = JSON.parse(new TextDecoder().decode(xzDecompress(payload)));
  }

  async #loadViaDefinition(def) {
    const dev = this.t.device;
    this.vialProtocol = null;
    this.uid = 'via-' + (dev.vendorId ?? 0).toString(16).padStart(4, '0') + (dev.productId ?? 0).toString(16).padStart(4, '0');
    if (this.viaProtocol < 12) {
      throw new Error(`VIA protocol ${this.viaProtocol} is too old (QMK before 2022). Please update the firmware.`);
    }
    if (!def) {
      const err = new Error('This keyboard runs VIA, not Vial. Its layout needs the VIA definition (JSON).');
      err.code = 'needsDefinition';
      throw err;
    }
    const problem = checkViaDefinition(def, dev);
    if (problem) throw new Error(problem);
    this.definition = def;
  }

  async #finishUnlock(onProgress) {
    const keys = this.unlockKeys.map(([r, c]) => `row ${r}/column ${c}`).join(' + ');
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 130)); // firmware rule: poll slower than every 100 ms
      const res = await this.unlockPoll();
      if (res.unlocked) return;
      onProgress(0.5, `Finishing unlock: hold ${keys}`);
    }
  }

  async #loadEncoders() {
    this.encoders = {}; // "layer,index" -> [ccw, cw]
    const indices = new Set(parseVialLayout(this.definition).filter((k) => k.encoder).map((k) => k.encoder.index));
    for (let l = 0; l < this.layerCount; l++) {
      for (const idx of indices) {
        try {
          const d = await this.t.request([VIA.VIAL_PREFIX, VIAL.GET_ENCODER, l, idx], { timeout: 300, retries: 1 });
          this.encoders[l + ',' + idx] = [be16(d, 0), be16(d, 2)];
        } catch { /* encoder map not compiled in */ }
      }
    }
  }

  async #getSetting(qsid, bytes) {
    try {
      const d = await this.t.request([VIA.VIAL_PREFIX, VIAL.QMK_SETTINGS_GET, qsid & 0xff, qsid >> 8], { timeout: 300, retries: 1 });
      if (d[0] !== 0) return null;
      return bytes === 2 ? le16(d, 1) : d[1];
    } catch {
      return null;
    }
  }

  async #loadSettings() {
    const s = { tappingTerm: 200, permissiveHold: false, holdOnOtherKeyPress: false, oneshotTimeout: 0, tappingToggle: 5 };
    if (this.vialProtocol >= 4) {
      const tt = await this.#getSetting(QSID.TAPPING_TERM, 2);
      if (tt) s.tappingTerm = tt;
      const ph = await this.#getSetting(QSID.PERMISSIVE_HOLD, 1);
      if (ph !== null) s.permissiveHold = !!ph;
      const hokp = await this.#getSetting(QSID.HOLD_ON_OTHER_KEY_PRESS, 1);
      if (hokp !== null) s.holdOnOtherKeyPress = !!hokp;
      const ot = await this.#getSetting(QSID.OSK_TIMEOUT, 2);
      if (ot !== null) s.oneshotTimeout = ot;
      const tg = await this.#getSetting(QSID.TAPPING_TOGGLE, 1);
      if (tg) s.tappingToggle = tg;
    }
    this.settings = s;
  }

  async #loadTapDances() {
    this.tapDances = [];
    const used = new Set();
    for (const layer of this.keymap) for (const row of layer) for (const kc of row) {
      if (kc >= 0x5700 && kc <= 0x57ff) used.add(kc & 0xff);
    }
    if (!used.size || this.vialProtocol < 4) return;
    for (const idx of used) {
      try {
        const d = await this.t.request([VIA.VIAL_PREFIX, VIAL.DYNAMIC_ENTRY_OP, 0x01, idx], { timeout: 300, retries: 1 });
        if (d[0] !== 0) continue;
        this.tapDances[idx] = {
          onTap: le16(d, 1), onHold: le16(d, 3), onDoubleTap: le16(d, 5), onTapHold: le16(d, 7), tappingTerm: le16(d, 9),
        };
      } catch { /* ignore */ }
    }
  }

  async refreshUnlockStatus() {
    const d = await this.t.request([VIA.VIAL_PREFIX, VIAL.UNLOCK_STATUS]);
    this.unlocked = d[0] === 1;
    this.unlockInProgress = d[1] === 1;
    this.unlockKeys = [];
    for (let i = 0; i < 15; i++) {
      const r = d[2 + i * 2], c = d[3 + i * 2];
      if (r !== 255 && c !== 255) this.unlockKeys.push([r, c]);
    }
    return this.unlocked;
  }

  unlockStart() {
    return this.t.request([VIA.VIAL_PREFIX, VIAL.UNLOCK_START]);
  }

  /** Returns { unlocked, inProgress, counter } — must be called at intervals > 100 ms (firmware rule). */
  async unlockPoll() {
    const d = await this.t.request([VIA.VIAL_PREFIX, VIAL.UNLOCK_POLL]);
    this.unlocked = d[0] === 1;
    return { unlocked: d[0] === 1, inProgress: d[1] === 1, counter: d[2] };
  }

  async lock() {
    await this.t.request([VIA.VIAL_PREFIX, VIAL.LOCK]);
    this.unlocked = false;
  }

  /** Current switch matrix as an array of rows, each a Uint8Array(cols) of 0/1. Requires unlock. */
  async matrixPoll() {
    const d = await this.t.request([VIA.GET_KEYBOARD_VALUE, VIA_VALUE.SWITCH_MATRIX_STATE], { echo: 2, timeout: 250, retries: 1 });
    const rowBytes = Math.ceil(this.cols / 8);
    const pressed = [];
    for (let r = 0; r < this.rows; r++) {
      const start = 2 + r * rowBytes;
      for (let c = 0; c < this.cols; c++) {
        const byte = d[start + rowBytes - 1 - (c >> 3)];
        if ((byte >> (c & 7)) & 1) pressed.push(r + ',' + c);
      }
    }
    return pressed;
  }
}

/** Why a VIA definition JSON doesn't fit this device, or null if it does. */
export function checkViaDefinition(def, device) {
  if (!def || typeof def !== 'object' || !def.matrix?.rows || !def.matrix?.cols || !Array.isArray(def.layouts?.keymap)) {
    return 'This is not a VIA definition (matrix or layouts.keymap is missing).';
  }
  const id = (v) => (typeof v === 'string' ? parseInt(v, 16) : v);
  if (device && def.vendorId !== undefined && def.productId !== undefined
    && (id(def.vendorId) !== device.vendorId || id(def.productId) !== device.productId)) {
    return `This definition belongs to another keyboard (${def.name || 'unknown'}).`;
  }
  return null;
}

/** Find an already-permitted Vial device (no prompt), preferring the one with this "vendorId:productId". */
export async function findGrantedDevice(preferredId) {
  if (!('hid' in navigator)) return null;
  const devices = (await navigator.hid.getDevices()).filter(isRawHid);
  return devices.find((d) => deviceId(d) === preferredId) || devices[0] || null;
}

export const deviceId = (device) => device.vendorId + ':' + device.productId;

export function isRawHid(device) {
  return device.collections.some((c) => c.usagePage === RAW_HID_FILTER.usagePage && c.usage === RAW_HID_FILTER.usage);
}

/** Ask the user to pick the keyboard (needs a user gesture). */
export async function requestDevice() {
  const devices = await navigator.hid.requestDevice({ filters: [RAW_HID_FILTER] });
  return devices.find(isRawHid) || null;
}
