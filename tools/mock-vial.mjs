// A fake Vial keyboard speaking the raw-HID protocol like vial-qmk does
// (same command layout, same unlock timing rule). Used by tests.

export class MockVialDevice extends EventTarget {
  /**
   * demo: object in the format of demo/halcyon-kyria.json
   * opts: { definitionXz: Uint8Array (lzma-compressed vial.json), unlockKeys: [[r,c]], counterMax, insecure }
   */
  constructor(demo, opts = {}) {
    super();
    this.demo = demo;
    this.opened = false;
    this.productName = demo.name;
    this.collections = [{ usagePage: 0xff60, usage: 0x61 }];
    this.definition = opts.definitionXz;
    this.unlockKeys = opts.unlockKeys || [[0, 1], [4, 1]];
    this.counterMax = opts.counterMax ?? 50;
    this.unlocked = opts.insecure ? 1 : 0;
    this.inProgress = 0;
    this.counter = this.counterMax;
    this.timer = 0;
    this.pressed = new Set(); // "r,c"
    this.requests = 0;
  }

  async open() { this.opened = true; }
  async close() { this.opened = false; }

  press(...positions) { for (const p of positions) this.pressed.add(p); }
  release(...positions) { for (const p of positions) this.pressed.delete(p); }

  async sendReport(reportId, data) {
    if (!this.opened) throw new Error('device not opened');
    this.requests++;
    const msg = new Uint8Array(32);
    msg.set(data);
    const res = this.#handle(msg);
    setTimeout(() => {
      const ev = new Event('inputreport');
      ev.data = new DataView(res.buffer);
      this.dispatchEvent(ev);
    }, 0);
  }

  #handle(msg) {
    const d = this.demo;
    const { rows, cols } = d.definition.matrix;
    const now = performance.now();
    if (msg[0] === 0x01) { msg[1] = 0; msg[2] = 12; return msg; }
    if (msg[0] === 0x11) { msg[1] = d.layerCount; return msg; }
    if (msg[0] === 0x12) {
      const off = (msg[1] << 8) | msg[2], n = msg[3];
      for (let i = 0; i < n; i++) {
        const byteIdx = off + i, kcIdx = byteIdx >> 1;
        const l = Math.floor(kcIdx / (rows * cols)), r = Math.floor((kcIdx % (rows * cols)) / cols), c = kcIdx % cols;
        const kc = d.keymap[l][r][c];
        msg[4 + i] = byteIdx & 1 ? kc & 0xff : kc >> 8;
      }
      return msg;
    }
    if (msg[0] === 0x02 && msg[1] === 0x02) {
      const v = d.layoutOptionsValue >>> 0;
      msg[2] = v >>> 24; msg[3] = (v >> 16) & 0xff; msg[4] = (v >> 8) & 0xff; msg[5] = v & 0xff;
      return msg;
    }
    if (msg[0] === 0x02 && msg[1] === 0x03) {
      if (!this.unlocked) return msg; // "goto skip": buffer returned unchanged
      const rowBytes = Math.ceil(cols / 8);
      for (let r = 0; r < rows; r++) {
        let v = 0;
        for (let c = 0; c < cols; c++) if (this.pressed.has(r + ',' + c)) v |= 1 << c;
        for (let b = 0; b < rowBytes; b++) msg[2 + r * rowBytes + b] = (v >> (8 * (rowBytes - 1 - b))) & 0xff;
      }
      return msg;
    }
    if (msg[0] !== 0xfe) return msg;
    const out = new Uint8Array(32);
    switch (msg[1]) {
      case 0x00: out.set([6, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]); return out;
      case 0x01: { const s = this.definition.length; out.set([s & 0xff, (s >> 8) & 0xff, (s >> 16) & 0xff, s >>> 24]); return out; }
      case 0x02: {
        const page = msg[2] + (msg[3] << 8);
        const start = page * 32;
        out.set(this.definition.slice(start, start + 32));
        return out;
      }
      case 0x03: {
        const pair = d.encoders[msg[2] + ',' + msg[3]] || [0, 0];
        out.set([pair[0] >> 8, pair[0] & 0xff, pair[1] >> 8, pair[1] & 0xff]);
        return out;
      }
      case 0x05:
        out.fill(0xff);
        out[0] = this.unlocked; out[1] = this.inProgress;
        this.unlockKeys.forEach(([r, c], i) => { out[2 + i * 2] = r; out[3 + i * 2] = c; });
        return out;
      case 0x06:
        this.inProgress = 1; this.counter = this.counterMax; this.timer = now;
        return out;
      case 0x07: {
        if (this.inProgress) {
          const holding = this.unlockKeys.every(([r, c]) => this.pressed.has(r + ',' + c));
          if (now - this.timer > 100 && holding) {
            this.timer = now;
            if (--this.counter === 0) { this.inProgress = 0; this.unlocked = 1; }
          } else {
            this.counter = this.counterMax;
          }
        }
        out[0] = this.unlocked; out[1] = this.inProgress; out[2] = this.counter;
        return out;
      }
      case 0x08: this.unlocked = 0; return out;
      case 0x0a: {
        const qsid = msg[2] | (msg[3] << 8);
        const values = { 7: [200, 2], 22: [1, 1], 23: [0, 1], 6: [0, 2], 20: [5, 1] };
        if (!values[qsid]) { out[0] = 1; return out; }
        const [v, n] = values[qsid];
        out[0] = 0; out[1] = v & 0xff; if (n === 2) out[2] = v >> 8;
        return out;
      }
      case 0x0d: out[0] = 1; return out; // no tap dances configured
      default: return out;
    }
  }
}
