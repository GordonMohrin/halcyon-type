/*!
 * Split Keyboard for monkeytype 0.2.0 — live Vial keyboard for monkeytype.com
 * https://github.com/GordonMohrin/halcyon-type
 * Copyright (C) 2026 Gordon Mohrin. License: GPL-3.0-or-later (see LICENSE).
 * Keymap look and behavior adapted from monkeytype (https://github.com/monkeytypegame/monkeytype, GPL-3.0).
 */
(() => {
'use strict';
// ---- js/xz.js
const __m0 = (() => {

/**
 * xz.js - small, dependency-free XZ / LZMA decompressor (decode only).
 *
 * Supported input:
 *  - .xz streams as written by Python's lzma.compress() / liblzma: one or more
 *    blocks, LZMA2 filter only, any check type (CRC32 and CRC64 are verified,
 *    SHA-256 and others are skipped), concatenated streams with stream padding.
 *  - Legacy .lzma ("LZMA_Alone") files, used when the XZ magic is absent.
 *
 * Not supported: BCJ / Delta / other filters (an Error is thrown).
 * Bytes after a complete stream that are not another XZ stream are ignored,
 * the same way Python's lzma.decompress() ignores them.
 *
 * Usage:
 *   import { xzDecompress } from './xz.js';
 *   const json = JSON.parse(new TextDecoder().decode(xzDecompress(bytes)));
 */

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const FILTER_LZMA2 = 0x21;
const FILTER_NAMES = {
  0x03: 'Delta', 0x04: 'BCJ x86', 0x05: 'BCJ PowerPC', 0x06: 'BCJ IA-64',
  0x07: 'BCJ ARM', 0x08: 'BCJ ARM-Thumb', 0x09: 'BCJ SPARC', 0x0a: 'BCJ ARM64', 0x0b: 'BCJ RISC-V',
};

// Size in bytes of the check field for each of the 16 possible check IDs.
const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];
const CHECK_CRC32 = 0x01;
const CHECK_CRC64 = 0x04;

// LZMA model constants
const NUM_STATES = 12;
const LIT_STATES = 7;          // states 0..6 mean "previous symbol was a literal"
const POS_STATES_MAX = 16;     // pb <= 4
const LITERAL_CODER_SIZE = 0x300;
const MATCH_LEN_MIN = 2;
const MATCH_LEN_MAX = 273;
const LEN_TO_DIST_STATES = 4;
const DIST_MODEL_END = 14;     // distance slots >= 14 use direct bits + align bits
const FULL_DISTANCES = 128;
const ALIGN_BITS = 4;
const PROB_INIT = 1024;        // probability 0.5 in 11-bit fixed point

function fail(message) {
  return new Error(`xz: ${message}`);
}

/**
 * Decompress .xz (or legacy .lzma) data.
 * @param {Uint8Array} bytes compressed data
 * @returns {Uint8Array} decompressed data
 * @throws {Error} on corrupt, truncated or unsupported input
 */
function xzDecompress(bytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!(bytes instanceof Uint8Array)) throw fail('input must be a Uint8Array');

  const out = new OutputBuffer(Math.max(1024, bytes.length * 4));
  if (hasXzMagic(bytes, 0)) decodeXz(bytes, out);
  else decodeLzmaAlone(bytes, out);
  return out.toUint8Array();
}

// ---------------------------------------------------------------------------
// Small helpers

function hasXzMagic(buf, pos) {
  if (buf.length - pos < XZ_MAGIC.length) return false;
  return XZ_MAGIC.every((b, i) => buf[pos + i] === b);
}

function readU32(buf, pos) {
  return (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;
}

// Sequential reader for headers and the index (bounded by `end`).
class Cursor {
  constructor(buf, pos, end, what) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
    this.what = what;
  }

  byte() {
    if (this.pos >= this.end) throw fail(`truncated or corrupt ${this.what}`);
    return this.buf[this.pos++];
  }

  // XZ variable-length integer: 7 bits per byte, little endian, at most 9 bytes.
  varint() {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 9; i++) {
      const b = this.byte();
      value += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) {
        if (b === 0 && i > 0) break; // non-minimal encoding is invalid
        return value;
      }
      scale *= 128;
    }
    throw fail(`corrupt ${this.what} (bad integer)`);
  }
}

// ---------------------------------------------------------------------------
// CRC32 (headers, index, CRC32 check) and CRC64 (default check of lzma.compress)

const CRC32_TABLE = new Uint32Array(256);
const CRC64_TABLE_LO = new Uint32Array(256);
const CRC64_TABLE_HI = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[i] = c;

  // CRC64 (ECMA-182, reflected polynomial 0xC96C5795D7870F42) as two 32-bit halves
  let lo = i;
  let hi = 0;
  for (let k = 0; k < 8; k++) {
    const lsb = lo & 1;
    lo = (lo >>> 1) | ((hi & 1) << 31);
    hi >>>= 1;
    if (lsb) {
      lo ^= 0xd7870f42;
      hi ^= 0xc96c5795;
    }
  }
  CRC64_TABLE_LO[i] = lo;
  CRC64_TABLE_HI[i] = hi;
}

function crc32(buf, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Returns [low 32 bits, high 32 bits].
function crc64(buf, start, end) {
  let lo = 0xffffffff;
  let hi = 0xffffffff;
  for (let i = start; i < end; i++) {
    const idx = (lo ^ buf[i]) & 0xff;
    lo = ((lo >>> 8) | (hi << 24)) ^ CRC64_TABLE_LO[idx];
    hi = (hi >>> 8) ^ CRC64_TABLE_HI[idx];
  }
  return [~lo >>> 0, ~hi >>> 0];
}

// Verify the block check field at buf[pos]; unknown/SHA-256 checks are only skipped.
function verifyCheck(checkType, data, buf, pos) {
  if (checkType === CHECK_CRC32) {
    if (crc32(data, 0, data.length) !== readU32(buf, pos)) throw fail('CRC32 mismatch (data is corrupt)');
  } else if (checkType === CHECK_CRC64) {
    const [lo, hi] = crc64(data, 0, data.length);
    if (lo !== readU32(buf, pos) || hi !== readU32(buf, pos + 4)) throw fail('CRC64 mismatch (data is corrupt)');
  }
}

// ---------------------------------------------------------------------------
// Output buffer. It doubles as the LZ dictionary: matches copy from earlier output.

class OutputBuffer {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
  }

  // Make room for at least `extra` more bytes.
  reserve(extra) {
    const needed = this.pos + extra;
    if (needed <= this.buf.length) return;
    const grown = new Uint8Array(Math.max(needed, this.buf.length * 2));
    grown.set(this.buf.subarray(0, this.pos));
    this.buf = grown;
  }

  toUint8Array() {
    return this.buf.slice(0, this.pos);
  }
}

// ---------------------------------------------------------------------------
// Range decoder (adaptive binary arithmetic decoder used by LZMA)

class RangeDecoder {
  init(buf, pos, end) {
    if (end - pos < 5) throw fail('truncated LZMA data');
    if (buf[pos] !== 0) throw fail('corrupt LZMA data (bad range coder start)');
    this.buf = buf;
    this.end = end;
    this.pos = pos + 5;
    this.range = 0xffffffff;
    this.code = readBE32(buf, pos + 1);
    if (this.code === this.range) throw fail('corrupt LZMA data (bad range coder start)');
  }

  // Keep range >= 2^24 by shifting in the next input byte.
  normalize() {
    if (this.range < 0x1000000) {
      if (this.pos >= this.end) throw fail('truncated or corrupt LZMA data');
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
    }
  }

  // Decode one bit with the adaptive probability probs[i].
  bit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    let bit;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
      bit = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[i] = p - (p >>> 5);
      bit = 1;
    }
    this.normalize();
    return bit;
  }

  // Decode `numBits` bits, most significant first, using a binary tree of probabilities.
  bitTree(probs, base, numBits) {
    let symbol = 1;
    for (let i = 0; i < numBits; i++) symbol = (symbol << 1) | this.bit(probs, base + symbol);
    return symbol - (1 << numBits);
  }

  // Same as bitTree, but the bits come least significant first.
  reverseBitTree(probs, base, numBits) {
    let symbol = 1;
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      const bit = this.bit(probs, base + symbol);
      symbol = (symbol << 1) | bit;
      result |= bit << i;
    }
    return result;
  }

  // Decode bits with fixed probability 0.5.
  direct(numBits) {
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      this.range >>>= 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      result = (result << 1) | bit;
      this.normalize();
    }
    return result;
  }

  // A cleanly finished range coder ends with code == 0.
  isFinished() {
    return this.code === 0;
  }
}

function readBE32(buf, pos) {
  return ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0;
}

// ---------------------------------------------------------------------------
// LZMA decoder

// Decode the lc/lp/pb properties byte: (pb * 5 + lp) * 9 + lc.
function parseLzmaProps(byte, isLzma2) {
  if (byte >= 9 * 5 * 5) throw fail('corrupt data (invalid LZMA properties)');
  const lc = byte % 9;
  const lp = Math.floor(byte / 9) % 5;
  const pb = Math.floor(byte / 45);
  if (isLzma2 && lc + lp > 4) throw fail('corrupt LZMA2 data (lc + lp > 4)');
  return { lc, lp, pb };
}

// Match length decoder: 2..9 (low), 10..17 (mid), 18..273 (high).
class LenDecoder {
  constructor() {
    this.choice = new Uint16Array(2);
    this.low = new Uint16Array(POS_STATES_MAX << 3);
    this.mid = new Uint16Array(POS_STATES_MAX << 3);
    this.high = new Uint16Array(256);
  }

  reset() {
    this.choice.fill(PROB_INIT);
    this.low.fill(PROB_INIT);
    this.mid.fill(PROB_INIT);
    this.high.fill(PROB_INIT);
  }

  decode(rc, posState) {
    if (rc.bit(this.choice, 0) === 0) return MATCH_LEN_MIN + rc.bitTree(this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return MATCH_LEN_MIN + 8 + rc.bitTree(this.mid, posState << 3, 3);
    return MATCH_LEN_MIN + 16 + rc.bitTree(this.high, 0, 8);
  }
}

class LzmaDecoder {
  constructor() {
    this.isMatch = new Uint16Array(NUM_STATES << 4);
    this.isRep = new Uint16Array(NUM_STATES);
    this.isRepG0 = new Uint16Array(NUM_STATES);
    this.isRepG1 = new Uint16Array(NUM_STATES);
    this.isRepG2 = new Uint16Array(NUM_STATES);
    this.isRep0Long = new Uint16Array(NUM_STATES << 4);
    this.distSlot = new Uint16Array(LEN_TO_DIST_STATES << 6);
    this.distSpecial = new Uint16Array(FULL_DISTANCES - DIST_MODEL_END);
    this.distAlign = new Uint16Array(1 << ALIGN_BITS);
    this.matchLen = new LenDecoder();
    this.repLen = new LenDecoder();
    this.literal = null;
  }

  setProps({ lc, lp, pb }) {
    const size = LITERAL_CODER_SIZE << (lc + lp);
    if (!this.literal || this.literal.length !== size) this.literal = new Uint16Array(size);
    this.lc = lc;
    this.litPosMask = (1 << lp) - 1;
    this.posMask = (1 << pb) - 1;
  }

  // State reset: all probabilities back to 0.5, state machine and rep distances to zero.
  reset() {
    for (const probs of [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2,
      this.isRep0Long, this.distSlot, this.distSpecial, this.distAlign, this.literal]) {
      probs.fill(PROB_INIT);
    }
    this.matchLen.reset();
    this.repLen.reset();
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  /**
   * Decode symbols into `out` until out.pos reaches `limit` or an end marker is read.
   * `dictStart` is the output position of the last dictionary reset; matches may not
   * reach before it. State and rep distances are kept for the next call (LZMA2 chunks).
   * Returns true if an end marker was decoded.
   */
  decode(rc, out, dictStart, limit, allowEndMarker) {
    const { lc, litPosMask, posMask, literal } = this;
    let { state, rep0, rep1, rep2, rep3 } = this;
    let buf = out.buf;
    let pos = out.pos;
    let endMarker = false;

    while (pos < limit) {
      if (buf.length - pos < MATCH_LEN_MAX) {
        out.pos = pos;
        out.reserve(Math.min(MATCH_LEN_MAX, limit - pos));
        buf = out.buf;
      }
      const dictPos = pos - dictStart; // also the number of bytes available for matches
      const posState = dictPos & posMask;

      if (rc.bit(this.isMatch, (state << 4) | posState) === 0) {
        // Literal: context is the low position bits and the high bits of the previous byte
        const prev = dictPos > 0 ? buf[pos - 1] : 0;
        const base = LITERAL_CODER_SIZE * (((dictPos & litPosMask) << lc) + (prev >>> (8 - lc)));
        let symbol = 1;
        if (state < LIT_STATES) {
          while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literal, base + symbol);
        } else {
          // Matched literal: the byte at distance rep0 steers the probabilities
          // until the first bit that differs from it.
          let matchByte = buf[pos - rep0 - 1] << 1;
          let offset = 0x100;
          while (symbol < 0x100) {
            const matchBit = matchByte & offset;
            matchByte <<= 1;
            const bit = rc.bit(literal, base + offset + matchBit + symbol);
            symbol = (symbol << 1) | bit;
            offset &= bit ? matchBit : ~matchBit;
          }
        }
        buf[pos++] = symbol & 0xff;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }

      let len;
      if (rc.bit(this.isRep, state) === 0) {
        // New match: length first, then distance
        len = this.matchLen.decode(rc, posState);
        state = state < LIT_STATES ? 7 : 10;
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        rep0 = this.decodeDistance(rc, len);
        if (rep0 === 0xffffffff) {
          if (!allowEndMarker) throw fail('corrupt LZMA2 data (unexpected end marker)');
          endMarker = true;
          break;
        }
      } else {
        // Repeated match with one of the four most recent distances
        if (rc.bit(this.isRepG0, state) === 0) {
          if (rc.bit(this.isRep0Long, (state << 4) | posState) === 0) {
            // Short rep: a single byte from distance rep0
            if (rep0 >= dictPos) throw fail('corrupt data (distance beyond start of dictionary)');
            buf[pos] = buf[pos - rep0 - 1];
            pos++;
            state = state < LIT_STATES ? 9 : 11;
            continue;
          }
        } else {
          // Use rep1, rep2 or rep3 and move it to the front
          let dist;
          if (rc.bit(this.isRepG1, state) === 0) {
            dist = rep1;
          } else {
            if (rc.bit(this.isRepG2, state) === 0) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        len = this.repLen.decode(rc, posState);
        state = state < LIT_STATES ? 8 : 11;
      }

      // Copy `len` bytes from distance rep0 + 1 (byte by byte: source and target may overlap)
      if (rep0 >= dictPos) throw fail('corrupt data (distance beyond start of dictionary)');
      if (len > limit - pos) throw fail('corrupt data (match goes past the end of the chunk)');
      let src = pos - rep0 - 1;
      const end = pos + len;
      while (pos < end) buf[pos++] = buf[src++];
    }

    out.pos = pos;
    this.state = state;
    this.rep0 = rep0;
    this.rep1 = rep1;
    this.rep2 = rep2;
    this.rep3 = rep3;
    return endMarker;
  }

  // Returns the match distance minus one (0xFFFFFFFF = end marker).
  decodeDistance(rc, len) {
    const lenState = Math.min(len - MATCH_LEN_MIN, LEN_TO_DIST_STATES - 1);
    const slot = rc.bitTree(this.distSlot, lenState << 6, 6);
    if (slot < 4) return slot;

    const numBits = (slot >>> 1) - 1;
    const base = ((2 | (slot & 1)) << numBits) >>> 0;
    if (slot < DIST_MODEL_END) {
      return base + rc.reverseBitTree(this.distSpecial, base - slot - 1, numBits);
    }
    const direct = rc.direct(numBits - ALIGN_BITS);
    const align = rc.reverseBitTree(this.distAlign, 0, ALIGN_BITS);
    return base + direct * (1 << ALIGN_BITS) + align;
  }
}

// ---------------------------------------------------------------------------
// LZMA2: a sequence of LZMA and uncompressed chunks

/**
 * Decode LZMA2 data starting at buf[pos] into `out`. Returns the position after
 * the LZMA2 end byte (0x00).
 */
function decodeLzma2(buf, pos, end, out, lzma, rc) {
  let needDictReset = true;
  let needProps = true;
  let dictStart = out.pos;

  for (;;) {
    if (pos >= end) throw fail('truncated LZMA2 data');
    const control = buf[pos++];
    if (control === 0x00) return pos; // end of LZMA2 data

    if (control >= 0xe0 || control === 0x01) {
      // Dictionary reset; the next LZMA chunk must then bring new properties
      dictStart = out.pos;
      needDictReset = false;
      needProps = true;
    } else if (needDictReset) {
      throw fail('corrupt LZMA2 data (first chunk does not reset the dictionary)');
    }

    if (control >= 0x80) {
      // LZMA chunk: bits 0-4 of control + 2 bytes = uncompressed size - 1,
      // 2 bytes = compressed size - 1, then a properties byte if control >= 0xC0.
      if (end - pos < 4) throw fail('truncated LZMA2 data');
      const unpackedSize = ((control & 0x1f) << 16) + (buf[pos] << 8) + buf[pos + 1] + 1;
      const packedSize = (buf[pos + 2] << 8) + buf[pos + 3] + 1;
      pos += 4;

      if (control >= 0xc0) {
        // New properties (implies state reset)
        if (pos >= end) throw fail('truncated LZMA2 data');
        lzma.setProps(parseLzmaProps(buf[pos++], true));
        lzma.reset();
        needProps = false;
      } else if (needProps) {
        throw fail('corrupt LZMA2 data (missing LZMA properties)');
      } else if (control >= 0xa0) {
        lzma.reset(); // state reset, same properties
      }
      // 0x80-0x9F: continue with the current state

      if (end - pos < packedSize) throw fail('truncated LZMA2 data');
      out.reserve(unpackedSize);
      rc.init(buf, pos, pos + packedSize); // every LZMA chunk restarts the range coder
      lzma.decode(rc, out, dictStart, out.pos + unpackedSize, false);
      if (rc.pos !== pos + packedSize || !rc.isFinished()) {
        throw fail('corrupt LZMA2 data (chunk size mismatch)');
      }
      pos += packedSize;
    } else {
      // Uncompressed chunk: 0x01 with dictionary reset, 0x02 without
      if (control > 0x02) throw fail(`corrupt LZMA2 data (invalid control byte 0x${control.toString(16)})`);
      if (end - pos < 2) throw fail('truncated LZMA2 data');
      const size = (buf[pos] << 8) + buf[pos + 1] + 1;
      pos += 2;
      if (end - pos < size) throw fail('truncated LZMA2 data');
      out.reserve(size);
      out.buf.set(buf.subarray(pos, pos + size), out.pos);
      out.pos += size;
      pos += size;
    }
  }
}

// ---------------------------------------------------------------------------
// XZ container

function decodeXz(buf, out) {
  let pos = 0;
  do {
    pos = decodeXzStream(buf, pos, out);
    // Stream padding: groups of four zero bytes between concatenated streams
    while (buf.length - pos >= 4 && readU32(buf, pos) === 0) pos += 4;
  } while (hasXzMagic(buf, pos));
}

// Decode one stream (header, blocks, index, footer). Returns the position after it.
function decodeXzStream(buf, pos, out) {
  const streamStart = pos;

  // Stream header: magic (6), flags (2), CRC32 of the flags (4)
  if (buf.length - pos < 12) throw fail('truncated stream header');
  if (buf[pos + 6] !== 0 || buf[pos + 7] > 0x0f) throw fail('unsupported stream flags');
  if (crc32(buf, pos + 6, pos + 8) !== readU32(buf, pos + 8)) throw fail('stream header CRC mismatch');
  const checkType = buf[pos + 7];
  const checkSize = CHECK_SIZES[checkType];
  pos += 12;

  const lzma = new LzmaDecoder();
  const rc = new RangeDecoder();
  const records = []; // [unpadded size, uncompressed size] per block, compared with the index

  // Blocks follow until the index indicator (a zero byte)
  for (;;) {
    if (pos >= buf.length) throw fail('truncated stream (index missing)');
    if (buf[pos] === 0x00) break;

    const blockStart = pos;
    const outStart = out.pos;
    const header = parseBlockHeader(buf, pos);
    pos = decodeLzma2(buf, pos + header.size, buf.length, out, lzma, rc);

    const packedSize = pos - blockStart - header.size;
    const unpackedSize = out.pos - outStart;
    if (header.packedSize >= 0 && header.packedSize !== packedSize) throw fail('block compressed size mismatch');
    if (header.unpackedSize >= 0 && header.unpackedSize !== unpackedSize) throw fail('block uncompressed size mismatch');

    // Block padding: zero bytes up to a multiple of four
    while ((pos - blockStart) & 3) {
      if (pos >= buf.length || buf[pos] !== 0) throw fail('corrupt block padding');
      pos++;
    }

    if (buf.length - pos < checkSize) throw fail('truncated block check');
    verifyCheck(checkType, out.buf.subarray(outStart, out.pos), buf, pos);
    pos += checkSize;
    records.push([header.size + packedSize + checkSize, unpackedSize]);
  }

  const indexStart = pos;
  pos = parseIndex(buf, pos, records);
  const indexSize = pos - indexStart;

  // Stream footer: CRC32 (4), backward size (4), flags (2), magic "YZ" (2)
  if (buf.length - pos < 12) throw fail('truncated stream footer');
  if (crc32(buf, pos + 4, pos + 10) !== readU32(buf, pos)) throw fail('stream footer CRC mismatch');
  if ((readU32(buf, pos + 4) + 1) * 4 !== indexSize) throw fail('stream footer does not match the index');
  if (buf[pos + 8] !== buf[streamStart + 6] || buf[pos + 9] !== buf[streamStart + 7]) {
    throw fail('stream footer flags do not match the header');
  }
  if (buf[pos + 10] !== 0x59 || buf[pos + 11] !== 0x5a) throw fail('bad stream footer magic');
  return pos + 12;
}

function parseBlockHeader(buf, pos) {
  // Header size is stored as (size / 4) - 1; the last four bytes are its CRC32
  const size = (buf[pos] + 1) * 4;
  if (buf.length - pos < size) throw fail('truncated block header');
  const crcPos = pos + size - 4;
  if (crc32(buf, pos, crcPos) !== readU32(buf, crcPos)) throw fail('block header CRC mismatch');

  const cur = new Cursor(buf, pos + 1, crcPos, 'block header');
  const flags = cur.byte();
  if (flags & 0x3c) throw fail('unsupported block header flags');
  const packedSize = flags & 0x40 ? cur.varint() : -1;
  const unpackedSize = flags & 0x80 ? cur.varint() : -1;

  const numFilters = (flags & 0x03) + 1;
  for (let i = 0; i < numFilters; i++) {
    const id = cur.varint();
    const propsSize = cur.varint();
    if (id !== FILTER_LZMA2) {
      const name = FILTER_NAMES[id] ? ` (${FILTER_NAMES[id]})` : '';
      throw fail(`unsupported filter 0x${id.toString(16)}${name}, only LZMA2 is supported`);
    }
    // One property byte: dictionary size. Not needed here, since the whole
    // output serves as dictionary, but it must be valid.
    if (propsSize !== 1 || cur.byte() > 40) throw fail('corrupt LZMA2 filter properties');
  }
  if (numFilters !== 1) throw fail('unsupported filter chain, only a single LZMA2 filter is supported');

  while (cur.pos < crcPos) {
    if (buf[cur.pos++] !== 0) throw fail('corrupt block header padding');
  }
  return { size, packedSize, unpackedSize };
}

// Parse the index and compare it with the decoded blocks. Returns the position after it.
function parseIndex(buf, pos, records) {
  const start = pos;
  const cur = new Cursor(buf, pos + 1, buf.length, 'index'); // skip the index indicator
  if (cur.varint() !== records.length) throw fail('index does not match the blocks');
  for (const [unpaddedSize, unpackedSize] of records) {
    if (cur.varint() !== unpaddedSize || cur.varint() !== unpackedSize) {
      throw fail('index does not match the blocks');
    }
  }
  while ((cur.pos - start) & 3) {
    if (cur.byte() !== 0) throw fail('corrupt index padding');
  }
  pos = cur.pos;
  if (buf.length - pos < 4) throw fail('truncated index');
  if (crc32(buf, start, pos) !== readU32(buf, pos)) throw fail('index CRC mismatch');
  return pos + 4;
}

// ---------------------------------------------------------------------------
// Legacy .lzma ("LZMA_Alone"): props (1), dictionary size (LE32),
// uncompressed size (LE64, all 0xFF = unknown, then an end marker is required)

function decodeLzmaAlone(buf, out) {
  const notCompressed = () => fail('input is neither XZ nor LZMA data');
  if (buf.length < 13 || buf[0] >= 9 * 5 * 5) throw notCompressed();
  if (!isValidDictSize(readU32(buf, 1))) throw notCompressed();

  const sizeLo = readU32(buf, 5);
  const sizeHi = readU32(buf, 9);
  const sizeKnown = sizeLo !== 0xffffffff || sizeHi !== 0xffffffff;
  if (sizeKnown && sizeHi >= 64) throw notCompressed(); // >= 256 GiB: not a real .lzma header
  const size = sizeHi * 0x100000000 + sizeLo;

  const lzma = new LzmaDecoder();
  lzma.setProps(parseLzmaProps(buf[0], false));
  lzma.reset();
  const rc = new RangeDecoder();
  rc.init(buf, 13, buf.length);

  const sawEndMarker = lzma.decode(rc, out, 0, sizeKnown ? size : Infinity, true);
  if (sawEndMarker) {
    if (sizeKnown && out.pos !== size) throw fail('corrupt LZMA data (end marker before the declared size)');
    if (!rc.isFinished()) throw fail('corrupt LZMA data');
  }
}

// liblzma only accepts dictionary sizes of 2^n or 2^n + 2^(n-1) in .lzma headers.
function isValidDictSize(d) {
  if (d === 0xffffffff) return true;
  let x = d - 1;
  x |= x >>> 2;
  x |= x >>> 3;
  x |= x >>> 4;
  x |= x >>> 8;
  x |= x >>> 16;
  return ((x + 1) >>> 0) === d;
}

return { xzDecompress };
})();
// ---- js/kle.js
const __m1 = (() => {

// KLE (keyboard-layout-editor.com) deserializer and Vial layout extraction.
// Mirrors vial-gui's kle_serial.py and keyboard_widget.py placement rules, so a
// keyboard renders here exactly like in the Vial app (including layout options
// such as Halcyon modules, which are positioned via invisible "decal" keys).

const LABEL_MAP = [
  [0, 6, 2, 8, 9, 11, 3, 5, 1, 4, 7, 10],
  [1, 7, -1, -1, 9, 11, 4, -1, -1, -1, -1, 10],
  [3, -1, 5, -1, 9, 11, -1, -1, 4, -1, -1, 10],
  [4, -1, -1, -1, 9, 11, -1, -1, -1, -1, -1, 10],
  [0, 6, 2, 8, 10, -1, 3, 5, 1, 4, 7, -1],
  [1, 7, -1, -1, 10, -1, 4, -1, -1, -1, -1, -1],
  [3, -1, 5, -1, 10, -1, -1, -1, 4, -1, -1, -1],
  [4, -1, -1, -1, 10, -1, -1, -1, -1, -1, -1, -1],
];

function reorderLabels(labels, align) {
  const ret = new Array(12).fill(null);
  labels.forEach((l, i) => {
    if (l && LABEL_MAP[align][i] >= 0) ret[LABEL_MAP[align][i]] = l;
  });
  return ret;
}

function deserializeKle(rows) {
  const keys = [];
  const current = {
    x: 0, y: 0, width: 1, height: 1, x2: 0, y2: 0, width2: 0, height2: 0,
    rotation_angle: 0, rotation_x: 0, rotation_y: 0, decal: false, ghost: false,
  };
  const cluster = { x: 0, y: 0 };
  let align = 4;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue; // metadata object
    for (let k = 0; k < row.length; k++) {
      const item = row[k];
      if (typeof item === 'string') {
        const key = { ...current };
        key.width2 = current.width2 === 0 ? current.width : current.width2;
        key.height2 = current.height2 === 0 ? current.height : current.height2;
        key.labels = reorderLabels(item.split('\n'), align);
        keys.push(key);
        current.x += current.width;
        current.width = current.height = 1;
        current.x2 = current.y2 = current.width2 = current.height2 = 0;
        current.decal = false;
      } else {
        if (k !== 0 && ('r' in item || 'rx' in item || 'ry' in item)) {
          throw new Error('KLE: rotation can only be specified on the first key in a row');
        }
        if ('r' in item) current.rotation_angle = item.r;
        if ('rx' in item) { current.rotation_x = cluster.x = item.rx; current.x = cluster.x; current.y = cluster.y; }
        if ('ry' in item) { current.rotation_y = cluster.y = item.ry; current.x = cluster.x; current.y = cluster.y; }
        if ('a' in item) align = item.a;
        if ('x' in item) current.x += item.x;
        if ('y' in item) current.y += item.y;
        if ('w' in item) current.width = current.width2 = item.w;
        if ('h' in item) current.height = current.height2 = item.h;
        if ('x2' in item) current.x2 = item.x2;
        if ('y2' in item) current.y2 = item.y2;
        if ('w2' in item) current.width2 = item.w2;
        if ('h2' in item) current.height2 = item.h2;
        if ('d' in item) current.decal = item.d;
        if ('g' in item && item.g) current.ghost = item.g;
      }
    }
    current.y += 1;
    current.x = current.rotation_x;
  }
  return keys;
}

function rotatePoint(px, py, angleDeg, cx, cy) {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const dx = px - cx, dy = py - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/** Axis-aligned bounding box (in key units) of a key after rotation. */
function keyBounds(key) {
  const rects = [[key.x, key.y, key.width, key.height]];
  if (key.width2 !== key.width || key.height2 !== key.height || key.x2 || key.y2) {
    rects.push([key.x + key.x2, key.y + key.y2, key.width2, key.height2]);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y, w, h] of rects) {
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      const [rx, ry] = key.rotation_angle
        ? rotatePoint(px, py, key.rotation_angle, key.rotation_x, key.rotation_y)
        : [px, py];
      minX = Math.min(minX, rx); minY = Math.min(minY, ry);
      maxX = Math.max(maxX, rx); maxY = Math.max(maxY, ry);
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Parse a Vial definition into renderable keys.
 * Each key: { id, row, col, encoder?: {index, dir}, layoutIndex, layoutOption, decal, ...geometry }
 */
function parseVialLayout(definition) {
  const kle = deserializeKle(definition.layouts.keymap);
  const keys = [];
  for (const key of kle) {
    const out = { ...key, row: null, col: null, encoder: null, layoutIndex: -1, layoutOption: -1 };
    if (key.labels[4] === 'e') {
      const [idx, dir] = key.labels[0].split(',').map(Number);
      out.encoder = { index: idx, dir };
    } else if (key.decal || (key.labels[0] && key.labels[0].includes(','))) {
      if (key.labels[0] && key.labels[0].includes(',')) {
        const [row, col] = key.labels[0].split(',').map(Number);
        out.row = row; out.col = col;
      } else {
        out.row = 0; out.col = 0;
      }
    } else {
      continue; // pure label/ornament without matrix position
    }
    if (key.labels[8]) {
      const [idx, opt] = key.labels[8].split(',').map(Number);
      out.layoutIndex = idx; out.layoutOption = opt;
    }
    keys.push(out);
  }
  return keys;
}

/** Parse VIA layout option labels into [{ title, choices[], bits }]. */
function parseLayoutLabels(labels) {
  if (!labels) return [];
  return labels.map((l) => {
    if (typeof l === 'string') return { title: l, choices: ['Aus', 'An'], bits: 1, boolean: true };
    const [title, ...choices] = l;
    const n = choices.length - 1; // same as Python's (len - 1).bit_length() in vial-gui
    const bits = n <= 0 ? 0 : 32 - Math.clz32(n);
    return { title, choices, bits, boolean: false };
  });
}

/** Unpack the VIA layout-options integer: the last option occupies the lowest bits. */
function unpackLayoutOptions(value, options) {
  const choices = new Array(options.length).fill(0);
  let v = value >>> 0;
  for (let i = options.length - 1; i >= 0; i--) {
    const mask = (1 << options[i].bits) - 1;
    choices[i] = v & mask;
    v >>>= options[i].bits;
  }
  return choices;
}

/**
 * Select the keys visible for the given layout choices and position them like Vial does.
 * Returns { keys: [...with shiftX/shiftY], width, height } in key units.
 */
function placeKeys(allKeys, choices) {
  const common = allKeys.filter((k) => k.layoutIndex === -1);
  const optional = allKeys.filter((k) => k.layoutIndex !== -1);

  // Top-left of every (option, choice) group, decals included.
  const topLeft = new Map();
  for (const k of optional) {
    const id = k.layoutIndex + ',' + k.layoutOption;
    const b = keyBounds(k);
    const t = topLeft.get(id) || { x: 1e6, y: 1e6 };
    t.x = Math.min(t.x, b.minX); t.y = Math.min(t.y, b.minY);
    topLeft.set(id, t);
  }

  const placed = common.map((k) => ({ ...k, shiftX: 0, shiftY: 0 }));
  for (const k of optional) {
    if (k.layoutOption !== (choices[k.layoutIndex] ?? 0)) continue;
    const own = topLeft.get(k.layoutIndex + ',' + k.layoutOption);
    const base = topLeft.get(k.layoutIndex + ',0') || own;
    placed.push({ ...k, shiftX: base.x - own.x, shiftY: base.y - own.y });
  }

  const visible = placed.filter((k) => !k.decal);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of visible) {
    const b = keyBounds(k);
    minX = Math.min(minX, b.minX + k.shiftX); minY = Math.min(minY, b.minY + k.shiftY);
    maxX = Math.max(maxX, b.maxX + k.shiftX); maxY = Math.max(maxY, b.maxY + k.shiftY);
  }
  for (const k of visible) { k.shiftX -= minX; k.shiftY -= minY; }
  visible.forEach((k, i) => { k.id = i; });
  return { keys: visible, width: maxX - minX, height: maxY - minY };
}

return { deserializeKle, keyBounds, parseVialLayout, parseLayoutLabels, unpackLayoutOptions, placeKeys };
})();
// ---- js/hid.js
const __m2 = (() => {
const { xzDecompress } = __m0;
const { parseVialLayout } = __m1;
// Vial / VIA raw-HID protocol over WebHID.
// Every request is a 32-byte output report; the firmware answers with one
// 32-byte input report. Requests are strictly serialized.




const RAW_HID_FILTER = { usagePage: 0xff60, usage: 0x61 };
const MSG_LEN = 32;

const VIA = { PROTOCOL_VERSION: 0x01, GET_KEYBOARD_VALUE: 0x02, LAYER_COUNT: 0x11, KEYMAP_GET_BUFFER: 0x12, VIAL_PREFIX: 0xfe };
const VIA_VALUE = { LAYOUT_OPTIONS: 0x02, SWITCH_MATRIX_STATE: 0x03 };
const VIAL = {
  KEYBOARD_ID: 0x00, GET_SIZE: 0x01, GET_DEF: 0x02, GET_ENCODER: 0x03, UNLOCK_STATUS: 0x05, UNLOCK_START: 0x06,
  UNLOCK_POLL: 0x07, LOCK: 0x08, QMK_SETTINGS_GET: 0x0a, DYNAMIC_ENTRY_OP: 0x0d,
};
const QSID = { TAPPING_TERM: 7, OSK_TIMEOUT: 6, TAPPING_TOGGLE: 20, PERMISSIVE_HOLD: 22, HOLD_ON_OTHER_KEY_PRESS: 23 };

const UNLOCK_COUNTER_MAX = 50;

class HidTransport {
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
        reject(new Error('Zeitüberschreitung bei der Antwort der Tastatur'));
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

class VialKeyboard {
  constructor(transport, name = 'Tastatur') {
    this.t = transport;
    this.name = name;
  }

  /** Load everything needed for display. onProgress(fraction, text) is optional. */
  async load(onProgress = () => {}) {
    const t = this.t;
    onProgress(0.02, 'Protokoll');
    const via = await t.request([VIA.PROTOCOL_VERSION], { echo: 1 });
    this.viaProtocol = be16(via, 1);

    const id = await t.request([VIA.VIAL_PREFIX, VIAL.KEYBOARD_ID]);
    this.vialProtocol = le32(id, 0);
    if (this.vialProtocol === 0xffffffff || this.vialProtocol > 0xff) {
      throw new Error('Das ist keine Vial-Firmware (nur VIA). Diese App braucht Vial.');
    }
    this.uid = [...id.slice(4, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (this.vialProtocol < 6) {
      console.warn('Vial protocol', this.vialProtocol, '< 6: keycodes may be labelled wrongly (old QMK keycode layout).');
    }

    const sz = le32(await t.request([VIA.VIAL_PREFIX, VIAL.GET_SIZE]), 0);
    if (!sz || sz > 1 << 20) throw new Error('Ungültige Größe der Vial-Definition: ' + sz);
    const payload = new Uint8Array(sz);
    const blocks = Math.ceil(sz / MSG_LEN);
    for (let b = 0; b < blocks; b++) {
      const data = await t.request([VIA.VIAL_PREFIX, VIAL.GET_DEF, b & 0xff, (b >> 8) & 0xff, 0, 0]);
      payload.set(data.slice(0, Math.min(MSG_LEN, sz - b * MSG_LEN)), b * MSG_LEN);
      if (b % 8 === 0) onProgress(0.05 + 0.45 * (b / blocks), 'Layout-Definition');
    }
    this.definition = JSON.parse(new TextDecoder().decode(xzDecompress(payload)));
    this.rows = this.definition.matrix.rows;
    this.cols = this.definition.matrix.cols;

    // An unlock left half-done (page reloaded while holding the keys) makes the firmware ignore
    // everything but unlock commands, so keymap reads would come back empty: finish it first.
    await this.refreshUnlockStatus();
    if (this.unlockInProgress) await this.#finishUnlock(onProgress);

    this.layerCount = (await t.request([VIA.LAYER_COUNT], { echo: 1 }))[1];
    if (!this.layerCount) throw new Error('Die Tastatur hat keine Keymap geliefert. Bitte ab- und wieder anstecken.');

    // Whole keymap buffer: layer -> row -> col, big-endian 16-bit keycodes.
    const total = this.layerCount * this.rows * this.cols * 2;
    const buf = new Uint8Array(total);
    for (let off = 0; off < total; off += 28) {
      const n = Math.min(28, total - off);
      const data = await t.request([VIA.KEYMAP_GET_BUFFER, off >> 8, off & 0xff, n], { echo: 3 });
      buf.set(data.slice(4, 4 + n), off);
      onProgress(0.5 + 0.35 * (off / total), 'Keymap');
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

    onProgress(0.88, 'Encoder & Einstellungen');
    await this.#loadEncoders();
    await this.#loadSettings();
    await this.#loadTapDances();
    await this.refreshUnlockStatus();
    onProgress(1, 'Fertig');
    return this;
  }

  async #finishUnlock(onProgress) {
    const keys = this.unlockKeys.map(([r, c]) => `Zeile ${r}/Spalte ${c}`).join(' + ');
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 130)); // firmware rule: poll slower than every 100 ms
      const res = await this.unlockPoll();
      if (res.unlocked) return;
      onProgress(0.5, `Entsperren abschließen: ${keys} halten`);
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

/** Find an already-permitted Vial device (no prompt). */
async function findGrantedDevice() {
  if (!('hid' in navigator)) return null;
  const devices = await navigator.hid.getDevices();
  return devices.find(isRawHid) || null;
}

function isRawHid(device) {
  return device.collections.some((c) => c.usagePage === RAW_HID_FILTER.usagePage && c.usage === RAW_HID_FILTER.usage);
}

/** Ask the user to pick the keyboard (needs a user gesture). */
async function requestDevice() {
  const devices = await navigator.hid.requestDevice({ filters: [RAW_HID_FILTER] });
  return devices.find(isRawHid) || null;
}

return { RAW_HID_FILTER, UNLOCK_COUNTER_MAX, HidTransport, VialKeyboard, findGrantedDevice, isRawHid, requestDevice };
})();
// ---- js/keycodes.js
const __m3 = (() => {

// QMK keycodes as used by Vial protocol >= 6 (QMK's 2022+ keycode layout).
// Decodes 16-bit keycodes from the dynamic keymap into structured actions,
// produces keycap labels, and maps keycodes to the characters the host OS
// layout (US / German) would type.

const KC_NO = 0x0000;
const KC_TRNS = 0x0001;

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// [hid usage, QMK name, KeyboardEvent.code, label]
// Printable keys get their label from the host layout, so their label is omitted here.
const BASIC_TABLE = [
  [0x28, 'KC_ENT', 'Enter', '⏎'], [0x29, 'KC_ESC', 'Escape', 'Esc'], [0x2A, 'KC_BSPC', 'Backspace', '⌫'],
  [0x2B, 'KC_TAB', 'Tab', '⇥'], [0x2C, 'KC_SPC', 'Space', '␣'], [0x2D, 'KC_MINS', 'Minus'],
  [0x2E, 'KC_EQL', 'Equal'], [0x2F, 'KC_LBRC', 'BracketLeft'], [0x30, 'KC_RBRC', 'BracketRight'],
  [0x31, 'KC_BSLS', 'Backslash'], [0x32, 'KC_NUHS', 'Backslash'], [0x33, 'KC_SCLN', 'Semicolon'],
  [0x34, 'KC_QUOT', 'Quote'], [0x35, 'KC_GRV', 'Backquote'], [0x36, 'KC_COMM', 'Comma'],
  [0x37, 'KC_DOT', 'Period'], [0x38, 'KC_SLSH', 'Slash'], [0x39, 'KC_CAPS', 'CapsLock', '⇪'],
  [0x46, 'KC_PSCR', 'PrintScreen', 'PrtSc'], [0x47, 'KC_SCRL', 'ScrollLock', 'ScrLk'], [0x48, 'KC_PAUS', 'Pause', 'Pause'],
  [0x49, 'KC_INS', 'Insert', 'Ins'], [0x4A, 'KC_HOME', 'Home', 'Home'], [0x4B, 'KC_PGUP', 'PageUp', 'PgUp'],
  [0x4C, 'KC_DEL', 'Delete', '⌦'], [0x4D, 'KC_END', 'End', 'End'], [0x4E, 'KC_PGDN', 'PageDown', 'PgDn'],
  [0x4F, 'KC_RGHT', 'ArrowRight', '→'], [0x50, 'KC_LEFT', 'ArrowLeft', '←'], [0x51, 'KC_DOWN', 'ArrowDown', '↓'],
  [0x52, 'KC_UP', 'ArrowUp', '↑'], [0x53, 'KC_NUM', 'NumLock', 'Num'],
  [0x54, 'KC_PSLS', 'NumpadDivide'], [0x55, 'KC_PAST', 'NumpadMultiply'], [0x56, 'KC_PMNS', 'NumpadSubtract'],
  [0x57, 'KC_PPLS', 'NumpadAdd'], [0x58, 'KC_PENT', 'NumpadEnter', '⏎'],
  [0x62, 'KC_P0', 'Numpad0'], [0x63, 'KC_PDOT', 'NumpadDecimal'], [0x64, 'KC_NUBS', 'IntlBackslash'],
  [0x65, 'KC_APP', 'ContextMenu', '☰'], [0x66, 'KC_KB_POWER', 'Power', '⏻'], [0x67, 'KC_PEQL', 'NumpadEqual'],
  [0x74, 'KC_EXEC', null, 'Exec'], [0x75, 'KC_HELP', 'Help', 'Help'], [0x76, 'KC_MENU', null, 'Menu'],
  [0x77, 'KC_SLCT', 'Select', 'Sel'], [0x78, 'KC_STOP', null, 'Stop'], [0x79, 'KC_AGIN', 'Again', 'Again'],
  [0x7A, 'KC_UNDO', 'Undo', 'Undo'], [0x7B, 'KC_CUT', 'Cut', 'Cut'], [0x7C, 'KC_COPY', 'Copy', 'Copy'],
  [0x7D, 'KC_PSTE', 'Paste', 'Paste'], [0x7E, 'KC_FIND', 'Find', 'Find'], [0x7F, 'KC_KB_MUTE', null, 'Mute'],
  [0x80, 'KC_KB_VOLUME_UP', null, 'Vol+'], [0x81, 'KC_KB_VOLUME_DOWN', null, 'Vol−'],
  [0x82, 'KC_LCAP', null, '⇪L'], [0x83, 'KC_LNUM', null, 'NumL'], [0x84, 'KC_LSCR', null, 'ScrL'],
  [0x85, 'KC_PCMM', 'NumpadComma', ','],
  [0xA5, 'KC_PWR', null, '⏻'], [0xA6, 'KC_SLEP', null, 'Sleep'], [0xA7, 'KC_WAKE', null, 'Wake'],
  [0xA8, 'KC_MUTE', 'AudioVolumeMute', 'Mute'], [0xA9, 'KC_VOLU', 'AudioVolumeUp', 'Vol+'],
  [0xAA, 'KC_VOLD', 'AudioVolumeDown', 'Vol−'], [0xAB, 'KC_MNXT', 'MediaTrackNext', '⏭'],
  [0xAC, 'KC_MPRV', 'MediaTrackPrevious', '⏮'], [0xAD, 'KC_MSTP', 'MediaStop', '⏹'],
  [0xAE, 'KC_MPLY', 'MediaPlayPause', '⏯'], [0xAF, 'KC_MSEL', 'MediaSelect', 'Media'], [0xB0, 'KC_EJCT', 'Eject', '⏏'],
  [0xB1, 'KC_MAIL', 'LaunchMail', 'Mail'], [0xB2, 'KC_CALC', 'LaunchApp2', 'Calc'], [0xB3, 'KC_MYCM', 'LaunchApp1', 'PC'],
  [0xB4, 'KC_WSCH', 'BrowserSearch', 'Srch'], [0xB5, 'KC_WHOM', 'BrowserHome', 'WHome'], [0xB6, 'KC_WBAK', 'BrowserBack', 'Back'],
  [0xB7, 'KC_WFWD', 'BrowserForward', 'Fwd'], [0xB8, 'KC_WSTP', 'BrowserStop', 'WStop'], [0xB9, 'KC_WREF', 'BrowserRefresh', 'Refr'],
  [0xBA, 'KC_WFAV', 'BrowserFavorites', 'Fav'], [0xBB, 'KC_MFFD', null, '⏩'], [0xBC, 'KC_MRWD', null, '⏪'],
  [0xBD, 'KC_BRIU', null, '☀+'], [0xBE, 'KC_BRID', null, '☀−'], [0xBF, 'KC_CPNL', null, 'CPnl'],
  [0xC0, 'KC_ASST', null, 'Asst'], [0xC1, 'KC_MCTL', null, 'MCtl'], [0xC2, 'KC_LPAD', null, 'LPad'],
  [0xCD, 'KC_MS_U', null, 'M↑'], [0xCE, 'KC_MS_D', null, 'M↓'], [0xCF, 'KC_MS_L', null, 'M←'], [0xD0, 'KC_MS_R', null, 'M→'],
  [0xD9, 'KC_WH_U', null, 'W↑'], [0xDA, 'KC_WH_D', null, 'W↓'], [0xDB, 'KC_WH_L', null, 'W←'], [0xDC, 'KC_WH_R', null, 'W→'],
  [0xDD, 'KC_ACL0', null, 'Acc0'], [0xDE, 'KC_ACL1', null, 'Acc1'], [0xDF, 'KC_ACL2', null, 'Acc2'],
  [0xE0, 'KC_LCTL', 'ControlLeft'], [0xE1, 'KC_LSFT', 'ShiftLeft'], [0xE2, 'KC_LALT', 'AltLeft'], [0xE3, 'KC_LGUI', 'MetaLeft'],
  [0xE4, 'KC_RCTL', 'ControlRight'], [0xE5, 'KC_RSFT', 'ShiftRight'], [0xE6, 'KC_RALT', 'AltRight'], [0xE7, 'KC_RGUI', 'MetaRight'],
];
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(65 + i);
  BASIC_TABLE.push([0x04 + i, 'KC_' + ch, 'Key' + ch]);
}
for (let i = 0; i < 10; i++) {
  const d = (i + 1) % 10;
  BASIC_TABLE.push([0x1E + i, 'KC_' + d, 'Digit' + d]);
  if (i < 9) BASIC_TABLE.push([0x59 + i, 'KC_P' + (i + 1), 'Numpad' + (i + 1)]);
}
for (let i = 0; i < 12; i++) BASIC_TABLE.push([0x3A + i, 'KC_F' + (i + 1), 'F' + (i + 1), 'F' + (i + 1)]);
for (let i = 0; i < 12; i++) BASIC_TABLE.push([0x68 + i, 'KC_F' + (i + 13), 'F' + (i + 13), 'F' + (i + 13)]);
for (let i = 0; i < 9; i++) BASIC_TABLE.push([0x87 + i, 'KC_INT' + (i + 1), null, 'Int' + (i + 1)]);
for (let i = 0; i < 9; i++) BASIC_TABLE.push([0x90 + i, 'KC_LNG' + (i + 1), i < 2 ? 'Lang' + (i + 1) : null, 'Lng' + (i + 1)]);
for (let i = 0; i < 8; i++) BASIC_TABLE.push([0xD1 + i, 'KC_BTN' + (i + 1), null, 'M' + (i + 1)]);

const BASIC = new Map(BASIC_TABLE.map(([hid, name, code, label]) => [hid, { hid, name, code, label }]));

// KeyboardEvent.code -> HID usage. Later entries must not override the preferred
// QMK codes (e.g. KC_VOLU 0xA9 instead of the rarely used 0x80).
const DOM_CODE_TO_HID = new Map();
for (const [hid, , code] of BASIC_TABLE) {
  if (code && !DOM_CODE_TO_HID.has(code)) DOM_CODE_TO_HID.set(code, hid);
}

// ---------------------------------------------------------------------------
// Modifiers

// QMK 5-bit mod mask (bit4 = right hand) -> 8-bit HID modifier byte.
function qmkModsToHid(mods) {
  return mods & 0x10 ? (mods & 0x0f) << 4 : mods & 0x0f;
}

// HID modifier byte bits
const MOD = { LCTL: 0x01, LSFT: 0x02, LALT: 0x04, LGUI: 0x08, RCTL: 0x10, RSFT: 0x20, RALT: 0x40, RGUI: 0x80 };
const MOD_KEYS = { 0xE0: MOD.LCTL, 0xE1: MOD.LSFT, 0xE2: MOD.LALT, 0xE3: MOD.LGUI, 0xE4: MOD.RCTL, 0xE5: MOD.RSFT, 0xE6: MOD.RALT, 0xE7: MOD.RGUI };

const MOD_SYMBOLS = IS_MAC
  ? { ctrl: '⌃', shift: '⇧', alt: '⌥', gui: '⌘' }
  : { ctrl: 'Strg', shift: '⇧', alt: 'Alt', gui: 'Win' };
const MOD_NAMES = IS_MAC
  ? { ctrl: 'Control', shift: 'Shift', alt: 'Option', gui: 'Command' }
  : { ctrl: 'Strg', shift: 'Shift', alt: 'Alt', gui: 'Win' };

// Compact symbol string for an 8-bit HID modifier mask.
function modsSymbol(hidMods) {
  const m = hidMods | (hidMods >> 4);
  if ((m & 0x0f) === 0x0f) return 'Hyper';
  if ((m & 0x0f) === 0x07) return 'Meh';
  let s = '';
  if (m & 0x01) s += MOD_SYMBOLS.ctrl;
  if (m & 0x02) s += MOD_SYMBOLS.shift;
  if (m & 0x04) s += MOD_SYMBOLS.alt;
  if (m & 0x08) s += MOD_SYMBOLS.gui;
  return s;
}

function modsName(hidMods) {
  const parts = [];
  const add = (bitL, name) => {
    const l = hidMods & bitL, r = hidMods & (bitL << 4);
    if (l && r) parts.push(name);
    else if (l) parts.push(name + ' links');
    else if (r) parts.push(name + ' rechts');
  };
  add(0x01, MOD_NAMES.ctrl); add(0x02, MOD_NAMES.shift); add(0x04, MOD_NAMES.alt); add(0x08, MOD_NAMES.gui);
  return parts.join(' + ');
}

// ---------------------------------------------------------------------------
// Structural decoding of a keycode

const QUANTUM = {
  0x7C00: ['Boot', 'Bootloader'], 0x7C01: ['Reboot', 'Neustart'], 0x7C02: ['Debug', 'Debug umschalten'],
  0x7C03: ['EEPROM', 'EEPROM löschen'], 0x7C16: ['Esc~', 'Grave Escape'],
  0x7C1A: ['⇧(', 'Space Cadet Shift links'], 0x7C1B: ['⇧)', 'Space Cadet Shift rechts'],
  0x7C73: ['CapsW', 'Caps Word'], 0x7C77: ['Lower', 'Tri-Layer Lower (Layer 1)'], 0x7C78: ['Upper', 'Tri-Layer Upper (Layer 2)'],
  0x7C79: ['Rep', 'Repeat Key'], 0x7C7A: ['AltRep', 'Alternate Repeat Key'], 0x7C7B: ['LLock', 'Layer Lock'],
  0x7C53: ['Rec1', 'Dyn. Makro 1 aufnehmen'], 0x7C54: ['Rec2', 'Dyn. Makro 2 aufnehmen'], 0x7C55: ['RecStop', 'Aufnahme stoppen'],
  0x7C56: ['Play1', 'Dyn. Makro 1'], 0x7C57: ['Play2', 'Dyn. Makro 2'],
};
const QK_CAPS_WORD_TOGGLE = 0x7C73;
const FN_MO13 = 0x7C77;
const FN_MO23 = 0x7C78;
const QK_LAYER_LOCK = 0x7C7B;

const RGB_MATRIX = {
  0x7840: 'RGB on', 0x7841: 'RGB off', 0x7842: 'RGB ⏻', 0x7843: 'RGB →', 0x7844: 'RGB ←', 0x7845: 'Hue+', 0x7846: 'Hue−',
  0x7847: 'Sat+', 0x7848: 'Sat−', 0x7849: 'Hell+', 0x784A: 'Hell−', 0x784B: 'Tempo+', 0x784C: 'Tempo−',
};

/**
 * Decode a keycode into { type, ... }.
 * types: none, trns, basic, mods, modtap, layertap, layermod, to, mo, df, tg, osl, osm, tt, pdf,
 *        swap, td, magic, midi, macro, quantum, lighting, kb, unicode, other
 */
function decode(kc) {
  if (kc === KC_NO) return { type: 'none' };
  if (kc === KC_TRNS) return { type: 'trns' };
  if (kc <= 0x00FF) return { type: 'basic', base: kc };
  if (kc <= 0x1FFF) return { type: 'mods', base: kc & 0xFF, mods: qmkModsToHid((kc >> 8) & 0x1F) };
  if (kc <= 0x3FFF) return { type: 'modtap', base: kc & 0xFF, mods: qmkModsToHid((kc >> 8) & 0x1F) };
  if (kc <= 0x4FFF) return { type: 'layertap', base: kc & 0xFF, layer: (kc >> 8) & 0x0F };
  if (kc <= 0x51FF) return { type: 'layermod', layer: (kc >> 5) & 0x0F, mods: qmkModsToHid(kc & 0x1F) };
  if (kc <= 0x521F) return { type: 'to', layer: kc & 0x1F };
  if (kc <= 0x523F) return { type: 'mo', layer: kc & 0x1F };
  if (kc <= 0x525F) return { type: 'df', layer: kc & 0x1F };
  if (kc <= 0x527F) return { type: 'tg', layer: kc & 0x1F };
  if (kc <= 0x529F) return { type: 'osl', layer: kc & 0x1F };
  if (kc <= 0x52BF) return { type: 'osm', mods: qmkModsToHid(kc & 0x1F) };
  if (kc <= 0x52DF) return { type: 'tt', layer: kc & 0x1F };
  if (kc <= 0x52FF) return { type: 'pdf', layer: kc & 0x1F };
  if (kc >= 0x5600 && kc <= 0x56FF) return { type: 'swap', index: kc & 0xFF };
  if (kc >= 0x5700 && kc <= 0x57FF) return { type: 'td', index: kc & 0xFF };
  if (kc >= 0x7000 && kc <= 0x70FF) return { type: 'magic', index: kc & 0xFF };
  if (kc >= 0x7100 && kc <= 0x71FF) return { type: 'midi', index: kc & 0xFF };
  if (kc >= 0x7700 && kc <= 0x777F) return { type: 'macro', index: kc & 0x7F };
  if (kc >= 0x7800 && kc <= 0x78FF) return { type: 'lighting', code: kc };
  if (kc >= 0x7C00 && kc <= 0x7DFF) return { type: 'quantum', code: kc };
  if (kc >= 0x7E00 && kc <= 0x7FFF) return { type: 'kb', index: kc - 0x7E00 };
  if (kc >= 0x8000) return { type: 'unicode', code: kc };
  return { type: 'other', code: kc };
}

// ---------------------------------------------------------------------------
// Host keyboard layouts: hid -> [base, shift, alt, shift+alt]

const US_PRINTABLE = {
  0x1E: '1!', 0x1F: '2@', 0x20: '3#', 0x21: '4$', 0x22: '5%', 0x23: '6^', 0x24: '7&', 0x25: '8*', 0x26: '9(', 0x27: '0)',
  0x2D: '-_', 0x2E: '=+', 0x2F: '[{', 0x30: ']}', 0x31: '\\|', 0x32: '\\|', 0x33: ';:', 0x34: '\'"', 0x35: '`~',
  0x36: ',<', 0x37: '.>', 0x38: '/?', 0x64: '\\|',
};
const DE_PRINTABLE = {
  0x1E: '1!', 0x1F: '2"', 0x20: '3§', 0x21: '4$', 0x22: '5%', 0x23: '6&', 0x24: '7/', 0x25: '8(', 0x26: '9)', 0x27: '0=',
  0x2D: 'ß?', 0x2E: '´`', 0x2F: 'üÜ', 0x30: '+*', 0x31: '#\'', 0x32: '#\'', 0x33: 'öÖ', 0x34: 'äÄ', 0x35: '^°',
  0x36: ',;', 0x37: '.:', 0x38: '-_', 0x64: '<>',
};
// macOS German: Option layer (index 2) and a few Shift+Option chars (index 3)
const DE_MAC_ALT = {
  0x1E: '¡¬', 0x1F: '“”', 0x20: '¶', 0x21: '¢£', 0x22: '[', 0x23: ']', 0x24: '|\\', 0x25: '{', 0x26: '}', 0x27: '≠',
  0x2D: '¿', 0x30: '±', 0x36: '∞', 0x37: '…÷', 0x38: '–—', 0x64: '≤≥',
  0x14: '«»', 0x1A: '∑', 0x08: '€', 0x15: '®', 0x17: '†', 0x1C: 'Ω', 0x0C: '⁄', 0x12: 'ø', 0x13: 'π',
  0x04: 'å', 0x07: '∂', 0x09: 'ƒ', 0x0A: '©', 0x0B: 'ª', 0x0D: 'º', 0x0E: '∆', 0x0F: '@', 0x1D: '¥',
  0x1B: '≈', 0x06: 'ç', 0x19: '√', 0x05: '∫', 0x11: '~', 0x10: 'µ',
};
// Windows/Linux German: AltGr layer
const DE_WIN_ALTGR = {
  0x14: '@', 0x08: '€', 0x10: 'µ', 0x1F: '²', 0x20: '³', 0x24: '{', 0x25: '[', 0x26: ']', 0x27: '}', 0x2D: '\\',
  0x30: '~', 0x64: '|',
};
const NUMPAD = { 0x54: '/', 0x55: '*', 0x56: '-', 0x57: '+', 0x63: '.', 0x67: '=', 0x85: ',' };

function buildLayout(id, name, printable, altTable, altMode, swapYZ) {
  const chars = new Map();
  for (let i = 0; i < 26; i++) {
    let ch = String.fromCharCode(97 + i);
    if (swapYZ && ch === 'y') ch = 'z';
    else if (swapYZ && ch === 'z') ch = 'y';
    chars.set(0x04 + i, [ch, ch.toUpperCase(), null, null]);
  }
  for (const [hid, s] of Object.entries(printable)) {
    const [a, b] = [...s];
    chars.set(+hid, [a, b ?? null, null, null]);
  }
  for (const [hid, s] of Object.entries(altTable || {})) {
    const entry = chars.get(+hid) || [null, null, null, null];
    const [a, b] = [...s];
    entry[2] = a ?? null;
    entry[3] = b ?? null;
    chars.set(+hid, entry);
  }
  for (const [hid, ch] of Object.entries(NUMPAD)) chars.set(+hid, [ch, null, null, null]);
  for (let i = 0; i < 9; i++) chars.set(0x59 + i, [String(i + 1), null, null, null]);
  chars.set(0x62, ['0', null, null, null]);
  chars.set(0x2C, [' ', ' ', null, null]);
  // Dead keys produce nothing on their own; they are still listed so hints can find them.
  const dead = id.startsWith('de') ? new Set(['´', '`', '^']) : new Set();
  return { id, name, chars, altMode, dead };
}

const HOST_LAYOUTS = {
  us: buildLayout('us', 'US (QWERTY)', US_PRINTABLE, null, 'none', false),
  'de-mac': buildLayout('de-mac', 'Deutsch (Mac)', DE_PRINTABLE, DE_MAC_ALT, 'option', true),
  'de-win': buildLayout('de-win', 'Deutsch (Windows/Linux)', DE_PRINTABLE, DE_WIN_ALTGR, 'altgr', true),
};

/** Best-effort detection of the OS keyboard layout via the Keyboard Map API. */
async function detectHostLayout() {
  try {
    if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
      const map = await navigator.keyboard.getLayoutMap();
      if (map.get('KeyY') === 'z' || map.get('Minus') === 'ß') return IS_MAC ? 'de-mac' : 'de-win';
      return 'us';
    }
  } catch { /* not allowed in this context */ }
  const lang = (navigator.language || '').toLowerCase();
  if (lang.startsWith('de')) return IS_MAC ? 'de-mac' : 'de-win';
  return 'us';
}

/** Character the host types for a basic keycode with an 8-bit HID modifier mask, or null. */
function charFor(hid, mods, host) {
  const entry = host.chars.get(hid);
  if (!entry) return null;
  const shift = (mods & 0x22) !== 0;
  let alt = false;
  if (host.altMode === 'option') {
    alt = (mods & 0x44) !== 0;
    if (mods & 0x99) return null; // ctrl / cmd -> shortcut, no character
  } else if (host.altMode === 'altgr') {
    alt = (mods & 0x40) !== 0 || ((mods & 0x11) && (mods & 0x04));
    if (!alt && (mods & 0x9D)) return null;
    if (alt && (mods & 0x88)) return null;
  } else {
    if (mods & 0xDD) return null;
  }
  const idx = (shift ? 1 : 0) + (alt ? 2 : 0);
  return entry[idx] ?? null;
}

// ---------------------------------------------------------------------------
// Labels

/**
 * live: { mods, caps } — modifiers currently in effect, so the keyboard shows what each key types *now*
 * (lowercase normally, uppercase / shifted symbols while Shift is held, Option/AltGr characters with Alt).
 */
function basicLabel(hid, host, live) {
  const info = BASIC.get(hid);
  if (MOD_KEYS[hid]) {
    const m = MOD_KEYS[hid];
    return { main: modsSymbol(m), sub: m & 0xF0 ? 'R' : 'L', cls: 'k-mod', desc: modsName(m) };
  }
  const entry = host.chars.get(hid);
  if (entry && hid !== 0x2C && !(hid >= 0x54 && hid <= 0x67 && hid !== 0x64)) {
    const base = entry[0];
    const isLetter = !!entry[1] && entry[1] !== base && entry[1] === base.toUpperCase();
    const desc = isLetter
      ? `Buchstabe ${base}`
      : `Zeichen ${base}${entry[1] ? ' (⇧ ' + entry[1] + ')' : ''}${entry[2] ? ' (' + MOD_SYMBOLS.alt + ' ' + entry[2] + ')' : ''}`;
    const mods = live ? live.mods & 0xFF : 0;
    const typing = mods & 0x66; // shift / alt change the character
    if (typing) {
      const ch = charFor(hid, mods, host);
      if (ch) return { main: ch, cls: (isLetter ? 'k-letter' : 'k-symbol') + ' k-modded', desc };
      if (!(mods & 0x99)) return { main: isLetter ? base : base, cls: (isLetter ? 'k-letter' : 'k-symbol') + ' k-dead', desc };
    }
    if (isLetter) return { main: live && live.caps ? base.toUpperCase() : base, cls: 'k-letter', desc };
    return { main: base, sub: entry[1] && entry[1] !== base ? entry[1] : undefined, alt: entry[2] || undefined, cls: 'k-symbol', desc };
  }
  if (entry && hid >= 0x54) return { main: entry[0], sub: 'Num', cls: 'k-symbol', desc: `Ziffernblock ${entry[0]}` };
  if (info && info.label) {
    let cls = 'k-fn';
    if (hid >= 0x4A && hid <= 0x52 && hid !== 0x4C) cls = 'k-nav';
    else if (hid >= 0xA5 && hid <= 0xC2) cls = 'k-media';
    else if (hid >= 0xCD && hid <= 0xDF) cls = 'k-mouse';
    else if (hid === 0x2C) cls = 'k-space';
    return { main: info.label, cls, desc: info.name };
  }
  return { main: info ? info.name.replace(/^KC_/, '') : '0x' + hid.toString(16), cls: 'k-fn', desc: info?.name || '' };
}

/**
 * Keycap label for a keycode. ctx: { host, tapDances, customKeycodes }, live: { mods, caps } or null
 * Returns { main, sub?, cls, desc }.
 */
function labelFor(kc, ctx, live = null) {
  const d = decode(kc);
  const host = ctx.host;
  switch (d.type) {
    case 'none': return { main: '', cls: 'k-none', desc: 'Keine Funktion' };
    case 'trns': return { main: '▽', cls: 'k-trns', desc: 'Transparent (Layer darunter)' };
    case 'basic': return basicLabel(d.base, host, live);
    case 'mods': {
      const ch = charFor(d.base, d.mods, host);
      const baseL = basicLabel(d.base, host);
      if (ch && ch.trim()) return { main: ch, cls: 'k-symbol', desc: `${modsName(d.mods)} + ${baseL.main} → ${ch}` };
      return { main: modsSymbol(d.mods) + baseL.main, cls: 'k-combo', desc: `${modsName(d.mods)} + ${baseL.desc}` };
    }
    case 'modtap': {
      const tap = basicLabel(d.base, host, live);
      return { main: tap.main, sub: modsSymbol(d.mods), cls: 'k-dual ' + tap.cls, dual: true,
        desc: `Tippen: ${tap.desc} · Halten: ${modsName(d.mods)}` };
    }
    case 'layertap': {
      const tap = basicLabel(d.base, host, live);
      return { main: tap.main, sub: 'L' + d.layer, cls: 'k-dual ' + tap.cls, dual: true,
        desc: `Tippen: ${tap.desc} · Halten: Layer ${d.layer}` };
    }
    case 'layermod': return { main: 'L' + d.layer, sub: '+' + modsSymbol(d.mods), cls: 'k-layer', desc: `Layer ${d.layer} + ${modsName(d.mods)} (halten)` };
    case 'mo': return { main: 'L' + d.layer, sub: 'MO', cls: 'k-layer', desc: `Layer ${d.layer} (halten)` };
    case 'to': return { main: 'L' + d.layer, sub: 'TO', cls: 'k-layer', desc: `Zu Layer ${d.layer} wechseln` };
    case 'df': return { main: 'L' + d.layer, sub: 'DF', cls: 'k-layer', desc: `Basis-Layer ${d.layer}` };
    case 'pdf': return { main: 'L' + d.layer, sub: 'PDF', cls: 'k-layer', desc: `Basis-Layer ${d.layer} (dauerhaft)` };
    case 'tg': return { main: 'L' + d.layer, sub: 'TG', cls: 'k-layer', desc: `Layer ${d.layer} umschalten` };
    case 'tt': return { main: 'L' + d.layer, sub: 'TT', cls: 'k-layer', desc: `Layer ${d.layer} halten / mehrfach tippen zum Umschalten` };
    case 'osl': return { main: 'L' + d.layer, sub: 'OSL', cls: 'k-layer', desc: `One-Shot Layer ${d.layer}` };
    case 'osm': return { main: modsSymbol(d.mods), sub: 'OSM', cls: 'k-mod', desc: `One-Shot ${modsName(d.mods)}` };
    case 'td': {
      const td = ctx.tapDances && ctx.tapDances[d.index];
      if (td && td.onTap) {
        const tap = labelFor(td.onTap, ctx, live);
        return { main: tap.main, sub: 'TD' + d.index, cls: 'k-dual ' + tap.cls, dual: !!td.onHold,
          desc: `Tap Dance ${d.index}: Tippen ${tap.desc}${td.onHold ? ' · Halten ' + labelFor(td.onHold, ctx).desc : ''}` };
      }
      return { main: 'TD' + d.index, cls: 'k-misc', desc: `Tap Dance ${d.index}` };
    }
    case 'macro': return { main: 'M' + d.index, cls: 'k-misc', desc: `Makro ${d.index}` };
    case 'kb': {
      const ck = ctx.customKeycodes && ctx.customKeycodes[d.index];
      if (ck) return { main: (ck.shortName || ck.name || '').replace(/\\n/g, '\n'), cls: 'k-misc', desc: ck.title || ck.name || '' };
      return { main: 'USER' + String(d.index).padStart(2, '0'), cls: 'k-misc', desc: `Eigener Keycode ${d.index}` };
    }
    case 'quantum': {
      const q = QUANTUM[d.code];
      if (q) return { main: q[0], cls: 'k-misc', desc: q[1] };
      return { main: 'QK', sub: d.code.toString(16), cls: 'k-misc', desc: 'Quantum 0x' + d.code.toString(16) };
    }
    case 'lighting': return { main: RGB_MATRIX[d.code] || 'RGB', cls: 'k-misc', desc: 'Beleuchtung' };
    case 'swap': return { main: 'SH', cls: 'k-misc', desc: 'Swap Hands' };
    case 'magic': return { main: 'Magic', cls: 'k-misc', desc: 'Magic-Keycode' };
    case 'midi': return { main: 'MIDI', cls: 'k-misc', desc: 'MIDI' };
    case 'unicode': return { main: 'U+', cls: 'k-misc', desc: 'Unicode' };
    default: return { main: '0x' + kc.toString(16).toUpperCase(), cls: 'k-misc', desc: 'Keycode 0x' + kc.toString(16) };
  }
}

/** Basic keycode a key emits when tapped (used for DOM-event fallback and hints). */
function tapKeycode(kc, ctx) {
  const d = decode(kc);
  if (d.type === 'basic') return { base: d.base, mods: 0 };
  if (d.type === 'mods') return { base: d.base, mods: d.mods };
  if (d.type === 'modtap' || d.type === 'layertap') return { base: d.base, mods: 0 };
  if (d.type === 'td' && ctx && ctx.tapDances && ctx.tapDances[d.index]) {
    const t = ctx.tapDances[d.index].onTap;
    if (t && t !== kc) return tapKeycode(t, null);
  }
  return null;
}

return { KC_NO, KC_TRNS, BASIC, DOM_CODE_TO_HID, qmkModsToHid, MOD, MOD_KEYS, MOD_SYMBOLS, MOD_NAMES, modsSymbol, QK_CAPS_WORD_TOGGLE, FN_MO13, FN_MO23, QK_LAYER_LOCK, decode, HOST_LAYOUTS, detectHostLayout, charFor, labelFor, tapKeycode };
})();
// ---- js/state.js
const __m4 = (() => {
const { decode, MOD_KEYS, KC_TRNS, FN_MO13, FN_MO23, QK_CAPS_WORD_TOGGLE, QK_LAYER_LOCK } = __m3;
// Reconstructs what the firmware is doing (active layers, modifiers, one-shots,
// tap-vs-hold decisions) from the raw switch matrix and the keymap.
// QMK itself does not report its layer state over raw HID, so we replay the
// relevant parts of QMK's logic on the host. This drives the on-screen keyboard.



const CAPS_WORD_IDLE_MS = 5000;

function highestBit(mask) {
  return mask ? 31 - Math.clz32(mask) : 0;
}

function continuesCapsWord(hid) {
  return (hid >= 0x04 && hid <= 0x27) || hid === 0x2D || hid === 0x2A || hid === 0x4C || hid === 0x38;
}

class FirmwareModel {
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

function lockedSnapshot({ dom, index, viewLayer, baseLayer, resolved = new Map() }) {
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

class DomKeyTracker {
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

return { FirmwareModel, lockedSnapshot, DomKeyTracker };
})();
// ---- js/keyboard-view.js
const __m5 = (() => {
const { labelFor, KC_TRNS } = __m3;
// SVG rendering of the physical keyboard with live state.



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

class KeyboardView {
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

return { KeyboardView };
})();
// ---- js/lookup.js
const __m6 = (() => {
const { decode, charFor, tapKeycode, BASIC, MOD_KEYS, FN_MO13, FN_MO23 } = __m3;
// Reverse lookups over the keymap:
//  - which physical key (and layer / modifiers) types a given character -> hints & heatmap
//  - which physical key produced a DOM KeyboardEvent.code              -> fallback without matrix access



/**
 * kb: { keymap, layerCount, positions: ["r,c", ...], keyX: Map(pos -> x center), centerX, ctx,
 *       preferred: { char: "layer:r,c" } — the way the user last typed a character that has several }
 */
class KeymapIndex {
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
   * Unlocked: remember which key typed ch (held: matrix records { pos, layer, kc, downAt }).
   * Returns true if the preference changed.
   */
  learn(ch, code, held) {
    if (!this.isAmbiguous(ch)) return false;
    const recs = [...held].sort((a, b) => b.downAt - a.downAt);
    const rec = recs.find((r) => this.codeAt(r.pos, r.layer) === code);
    if (!rec || !this.charPaths.get(ch).some((p) => p.pos === rec.pos && p.layer === rec.layer)) return false;
    const key = rec.layer + ':' + rec.pos;
    if (!this.kb.preferred || this.kb.preferred[ch] === key) return false;
    this.kb.preferred[ch] = key;
    return true;
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

return { KeymapIndex };
})();
// ---- js/hands.js
const __m7 = (() => {
const { keyBounds } = __m1;
// Finger assignment for split keyboards and a small two-hands view that shows
// which finger should press the next key (plus the fingers holding layer/modifier keys).



const FINGER_ORDER = ['index', 'index', 'middle', 'ring', 'pinky'];

/**
 * Assign every key to a hand and finger from the physical layout:
 * per half, columns are counted from the inside (2× index, middle, ring, pinky, pinky…);
 * rotated keys and the last matrix row of each half are thumb keys.
 * Returns { fingers: Map("r,c" -> {hand, finger, row, col}), homing: Set("r,c") }.
 */
function computeFingers(placed, matrixRows) {
  const centerX = placed.width / 2;
  const info = placed.keys.filter((k) => !k.encoder).map((k) => {
    const b = keyBounds(k);
    return {
      pos: k.row + ',' + k.col, row: k.row, rot: k.rotation_angle,
      cx: (b.minX + b.maxX) / 2 + k.shiftX, cy: (b.minY + b.maxY) / 2 + k.shiftY,
    };
  });
  const split = !info.some((i) => Math.abs(i.cx - centerX) < 0.45);
  const halfRows = matrixRows / 2;
  const thumbRow = (r) => split && Number.isInteger(halfRows) && (r === halfRows - 1 || r === matrixRows - 1);

  const fingers = new Map();
  const homing = new Set();
  for (const hand of ['L', 'R']) {
    const mine = info.filter((i) => (i.cx < centerX) === (hand === 'L'));
    const thumbs = mine.filter((i) => i.rot || thumbRow(i.row));
    const rest = mine.filter((i) => !thumbs.includes(i));
    const cols = new Map();
    for (const i of rest) {
      const x = Math.round(i.cx * 2) / 2;
      if (!cols.has(x)) cols.set(x, []);
      cols.get(x).push(i);
    }
    const order = [...cols.keys()].sort((a, b) => Math.abs(a - centerX) - Math.abs(b - centerX));
    order.forEach((x, ci) => {
      const finger = FINGER_ORDER[Math.min(ci, FINGER_ORDER.length - 1)];
      const list = cols.get(x).sort((a, b) => b.cy - a.cy); // bottom row first
      list.forEach((i, ri) => fingers.set(i.pos, { hand, finger, row: ri, col: ci }));
      if (ci === 1 && list[1]) homing.add(list[1].pos); // index finger on the home row
    });
    for (const t of thumbs) fingers.set(t.pos, { hand, finger: 'thumb', row: -1, col: -1 });
  }
  return { fingers, homing };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 420;

// one left hand, palm down: fingers point up, thumb on the right
const SHAPES = [
  ['palm', { x: 40, y: 72, width: 106, height: 70, rx: 28 }],
  ['pinky', { x: 42, y: 44, width: 20, height: 52, rx: 10 }],
  ['ring', { x: 66, y: 24, width: 22, height: 68, rx: 11 }],
  ['middle', { x: 92, y: 14, width: 22, height: 76, rx: 11 }],
  ['index', { x: 118, y: 26, width: 22, height: 66, rx: 11 }],
  ['thumb', { x: 124, y: 74, width: 22, height: 56, rx: 11, transform: 'rotate(40 135 126)' }],
];

class HandsView {
  constructor(container) {
    this.container = container;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} 150`);
    svg.setAttribute('class', 'hands-svg');
    svg.setAttribute('aria-hidden', 'true');
    this.parts = new Map();
    for (const hand of ['L', 'R']) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'hand hand-' + hand);
      if (hand === 'R') g.setAttribute('transform', `translate(${W} 0) scale(-1 1)`);
      for (const [name, attrs] of SHAPES) {
        const r = document.createElementNS(SVG_NS, 'rect');
        for (const [k, v] of Object.entries(attrs)) r.setAttribute(k, v);
        r.setAttribute('class', name === 'palm' ? 'palm' : 'finger');
        g.appendChild(r);
        if (name !== 'palm') this.parts.set(hand + '-' + name, r);
      }
      svg.appendChild(g);
    }
    container.appendChild(svg);
  }

  /** marks: { target: {hand, finger}|null, layer: [{hand, finger}], mod: [{hand, finger}] } */
  set(marks) {
    for (const r of this.parts.values()) r.setAttribute('class', 'finger');
    if (!marks) return;
    const add = (f, cls) => {
      if (!f) return;
      const r = this.parts.get(f.hand + '-' + f.finger);
      if (r) r.classList.add(cls);
    };
    for (const f of marks.layer || []) add(f, 'helper-layer');
    for (const f of marks.mod || []) add(f, 'helper-mod');
    add(marks.target, 'target');
  }
}

return { computeFingers, HandsView };
})();
// ---- monkeytype/overlay.js
const __m8 = (() => {
const { HidTransport, VialKeyboard, findGrantedDevice, requestDevice, isRawHid, UNLOCK_COUNTER_MAX } = __m2;
const { parseVialLayout, parseLayoutLabels, unpackLayoutOptions, placeKeys, keyBounds } = __m1;
const { HOST_LAYOUTS, detectHostLayout, MOD_SYMBOLS, MOD_NAMES, KC_TRNS, KC_NO } = __m3;
const { FirmwareModel, DomKeyTracker, lockedSnapshot } = __m4;
const { KeyboardView } = __m5;
const { KeymapIndex } = __m6;
const { computeFingers, HandsView } = __m7;
// Split Keyboard for monkeytype — live Vial keyboard inside monkeytype.com.
// Runs in the page (extension content script with world MAIN, or userscript), so you
// type in the real monkeytype with your own account; this only adds the keyboard below
// the words. Styling follows monkeytype's keymap (theme colors, next-key highlight,
// 250 ms correct/error flash), see LICENSE (GPL-3.0) and monkeytype's Keymap.tsx.









const DEMO_DATA = {"name":"Halcyon Kyria (Demo)","uid":"demo-halcyon-kyria","definition":{"lighting":"vialrgb","matrix":{"rows":8,"cols":12},"layouts":{"labels":["Soldered encoder left",["Halcyon module left","None","Encoder"],"Soldered encoder right",["Halcyon module right","None","Encoder"]],"keymap":[[{"y":0.25,"x":3},"0,3",{"x":9},"4,3"],[{"y":-0.75,"x":2},"0,4",{"x":1},"0,2",{"x":7},"4,2",{"x":1},"4,4"],[{"y":-0.875,"x":5},"0,1",{"x":5},"4,1"],[{"y":-0.625},"0,6","0,5",{"x":13},"4,5","4,6"],[{"y":-0.75,"x":3},"1,3",{"x":9},"5,3"],[{"y":-0.75,"x":2},"1,4",{"x":1},"1,2",{"x":7},"5,2",{"x":1},"5,4"],[{"y":-0.875,"x":5},"1,1",{"x":5},"5,1"],[{"y":-0.625},"1,6","1,5",{"x":13},"5,5","5,6"],[{"y":-0.75,"x":3},"2,3",{"x":9},"6,3"],[{"y":-0.75,"x":2},"2,4",{"x":1},"2,2",{"x":7},"6,2",{"x":1},"6,4"],[{"y":-0.875,"x":5},"2,1",{"x":5},"6,1"],[{"y":-0.625},"2,6","2,5",{"x":13},"6,5","6,6"],[{"y":-0.5,"x":2.5},"3,4",{"x":10},"7,4"],[{"rx":4,"ry":8.175,"y":-4.675,"x":-0.5},"3,2"],[{"rx":10.5,"ry":4.1,"y":2.25,"x":-10.5,"d":true},"1,0\n\n\n1,0\n\n\n\n\n\ne",{"d":true},"0,9\n\n\n1,0",{"d":true},"1,1\n\n\n1,0\n\n\n\n\n\ne",{"x":1,"d":true},"0,0\n\n\n0,0\n\n\n\n\n\ne",{"d":true},"0,1\n\n\n0,0\n\n\n\n\n\ne",{"x":5.25,"d":true},"2,0\n\n\n2,0\n\n\n\n\n\ne",{"d":true},"2,1\n\n\n2,0\n\n\n\n\n\ne",{"x":0.75,"d":true},"3,0\n\n\n3,0\n\n\n\n\n\ne",{"d":true},"4,9\n\n\n3,0",{"d":true},"3,1\n\n\n3,0\n\n\n\n\n\ne"],[{"x":-10.5,"d":true},"0,8\n\n\n1,0",{"d":true},"0,7\n\n\n1,0",{"d":true},"0,10\n\n\n1,0",{"x":1},"0,0\n\n\n0,1\n\n\n\n\n\ne","0,1\n\n\n0,1\n\n\n\n\n\ne",{"x":5.25},"2,0\n\n\n2,1\n\n\n\n\n\ne","2,1\n\n\n2,1\n\n\n\n\n\ne",{"x":0.75,"d":true},"4,8\n\n\n3,0",{"d":true},"4,7\n\n\n3,0",{"d":true},"4,10\n\n\n3,0"],[{"x":-9.5,"d":true},"0,11\n\n\n1,0",{"x":13,"d":true},"4,11\n\n\n3,0"],[{"y":0.5,"x":-10.5},"1,0\n\n\n1,1\n\n\n\n\n\ne",{"d":true},"0,9\n\n\n1,1","1,1\n\n\n1,1\n\n\n\n\n\ne",{"x":11},"3,0\n\n\n3,1\n\n\n\n\n\ne",{"d":true},"4,9\n\n\n3,1","3,1\n\n\n3,1\n\n\n\n\n\ne"],[{"x":-10.5,"d":true},"0,8\n\n\n1,1","0,7\n\n\n1,1",{"d":true},"0,10\n\n\n1,1",{"x":11,"d":true},"4,8\n\n\n3,1","4,7\n\n\n3,1",{"d":true},"4,10\n\n\n3,1"],[{"x":-9.5,"d":true},"0,11\n\n\n1,1",{"x":13,"d":true},"4,11\n\n\n3,1"],[{"rx":13,"ry":8.175,"y":-4.675,"x":-0.5},"7,2"],[{"r":15,"rx":4,"y":-4.675,"x":-0.5},"3,1"],[{"r":30,"y":-2,"x":-0.5},"3,3"],[{"x":-0.5},"3,5"],[{"r":45,"y":-2,"x":-0.5},"2,0"],[{"x":-0.5},"3,0"],[{"r":-45,"rx":13,"y":-5.675,"x":-0.5},"6,0"],[{"x":-0.5},"7,0"],[{"r":-30,"y":-2,"x":-0.5},"7,3"],[{"x":-0.5},"7,5"],[{"r":-15,"y":-1,"x":-0.5},"7,1"]]}},"keymap":[[[0,23,21,8,26,20,43,168,0,0,0,0],[0,10,9,7,22,4,8489,0,0,0,0,0],[57,5,25,6,27,29,225,0,0,0,0,0],[21027,9256,227,47,21030,44,0,0,0,0,0,0],[0,28,24,12,18,19,42,174,0,0,0,0],[0,11,13,14,15,51,12596,0,0,0,0,0],[21029,17,16,54,55,56,229,0,0,0,0,0],[21028,230,231,48,101,44,0,0,0,0,0,0]],[[1,28,19,55,54,52,43,1,1,1,1,1],[1,12,24,8,18,4,8489,1,1,1,1,1],[57,27,14,13,20,51,225,1,1,1,1,1],[21027,9256,227,47,21030,44,1,1,1,1,1,1],[1,9,10,6,21,15,42,1,1,1,1,1],[1,7,11,23,17,22,12589,1,1,1,1,1],[21029,5,16,26,25,29,229,1,1,1,1,1],[21028,230,231,48,101,44,1,1,1,1,1,1]],[[1,5,19,9,26,20,43,1,1,1,1,1],[1,10,23,22,21,4,8489,1,1,1,1,1],[57,25,7,6,27,29,225,1,1,1,1,1],[21027,9256,227,47,21030,44,1,1,1,1,1,1],[1,13,15,24,28,51,42,1,1,1,1,1],[1,16,17,8,12,18,12596,1,1,1,1,1],[21029,14,11,54,55,56,229,1,1,1,1,1],[21028,230,231,48,101,44,1,1,1,1,1,1]],[[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,225,224,226,227,1,1,1,1,1,1],[71,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,75,74,82,77,169,76,1,1,1,1,1],[1,78,80,81,79,170,73,1,1,1,1,1],[1,72,172,174,171,168,70,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1]],[[1,34,33,32,31,30,53,1,1,1,1,1],[1,546,545,544,543,542,565,1,1,1,1,1],[1,47,45,51,563,49,561,1,1,1,1,1],[1,1,1,559,1,1,1,1,1,1,1,1],[1,35,36,37,38,39,46,1,1,1,1,1],[1,547,548,549,550,551,558,1,1,1,1,1],[1,48,557,54,55,56,568,1,1,1,1,1],[1,1,1,560,1,1,1,1,1,1,1,1]],[[1,1,69,68,67,66,1,1,1,1,1,1],[1,1,65,64,63,62,1,1,1,1,1,1],[1,1,61,60,59,58,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,229,228,226,231,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1]],[[1,1,1,21056,1,1,1,1,1,1,1,1],[1,1,1,21057,1,1,1,1,1,1,1,1],[1,1,1,21058,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,30786,30791,30789,30793,30787,1,1,1,1,1,1],[1,1,30792,30790,30794,30788,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1]],[[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1]]],"layerCount":8,"encoders":{"0,0":[170,169],"0,1":[78,75],"0,2":[170,169],"0,3":[78,75],"1,0":[1,1],"1,1":[1,1],"1,2":[1,1],"1,3":[1,1],"2,0":[1,1],"2,1":[1,1],"2,2":[1,1],"2,3":[1,1],"3,0":[1,1],"3,1":[1,1],"3,2":[1,1],"3,3":[1,1],"4,0":[1,1],"4,1":[1,1],"4,2":[1,1],"4,3":[1,1],"5,0":[1,1],"5,1":[1,1],"5,2":[1,1],"5,3":[1,1],"6,0":[1,1],"6,1":[1,1],"6,2":[1,1],"6,3":[1,1],"7,0":[1,1],"7,1":[1,1],"7,2":[1,1],"7,3":[1,1]},"settings":{"tappingTerm":200,"permissiveHold":false,"holdOnOtherKeyPress":false,"oneshotTimeout":0,"tappingToggle":5},"tapDances":[],"layoutOptionsValue":5};
const CSS_TEXT = "/* Split Keyboard for monkeytype — uses monkeytype's theme variables so it follows every theme.\n   Key look follows monkeytype's keymap (Keymap.tsx, GPL-3.0): sub-alt keys, sub legends,\n   main-colored next key, 250 ms main/error flash, bg-colored homing bars. */\n\n.hmt {\n  --hmt-scale: 1;\n  --hmt-main: var(--main-color, #e2b714);\n  --hmt-bg: var(--bg-color, #323437);\n  --hmt-sub: var(--sub-color, #646669);\n  --hmt-subalt: var(--sub-alt-color, #2c2e31);\n  --hmt-text: var(--text-color, #d1d0c5);\n  --hmt-error: var(--error-color, #ca4754);\n  width: min(100%, calc(720px * var(--hmt-scale)));\n  margin: 1.6rem auto 0;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 0.6rem;\n  font-family: var(--font, \"Roboto Mono\", monospace);\n  color: var(--hmt-sub);\n  user-select: none;\n}\n\n.hmt [hidden] { display: none !important; }\n\n.hmt-bar { display: flex; justify-content: center; gap: 1.6rem; font-size: 0.75rem; min-height: 1.2rem; }\n.hmt-layers, .hmt-mods { display: flex; gap: 0.3rem; align-items: center; }\n.hmt-layer {\n  all: unset; cursor: pointer; width: 1.35rem; height: 1.35rem; border-radius: 0.3rem; text-align: center; line-height: 1.35rem;\n  color: var(--hmt-sub); background: transparent; font-size: 0.72rem; transition: color .12s, background .12s;\n}\n.hmt-layer.active { color: var(--hmt-text); background: var(--hmt-subalt); }\n.hmt-layer.shown { color: var(--hmt-bg); background: var(--hmt-main); }\n.hmt-layer.base:not(.shown) { box-shadow: inset 0 0 0 1px var(--hmt-sub); }\n.hmt-layer.pinned { outline: 1px dashed var(--hmt-main); outline-offset: 2px; }\n.hmt-mod { min-width: 1.35rem; height: 1.35rem; padding: 0 0.4rem; box-sizing: border-box; line-height: 1.35rem; text-align: center; white-space: nowrap; border-radius: 0.3rem; font-size: 0.85rem; color: var(--hmt-sub); opacity: .55; transition: all .08s; }\n.hmt-mod.on { opacity: 1; color: var(--hmt-bg); background: var(--hmt-main); }\n.hmt-mod.oneshot { opacity: 1; color: var(--hmt-main); box-shadow: inset 0 0 0 1px var(--hmt-main); }\n\n.hmt-kbd { width: 100%; display: flex; justify-content: center; }\n.hmt .kbd-svg { width: 100%; height: auto; overflow: visible; }\n.hmt-hands { width: min(100%, calc(330px * var(--hmt-scale))); margin-top: 0.4rem; }\n.hmt .hands-svg { width: 100%; height: auto; display: block; }\n.hmt-hint { font-size: 0.75rem; min-height: 1rem; color: var(--hmt-sub); }\n.hmt-notice { display: flex; gap: 0.6rem; align-items: center; justify-content: center; flex-wrap: wrap; font-size: 0.8rem; color: var(--hmt-text); max-width: 34rem; text-align: center; }\n.hmt-notice:empty { display: none; }\n.hmt-progress { width: 100%; height: 0.35rem; border-radius: 0.2rem; background: var(--hmt-subalt); overflow: hidden; }\n.hmt-progress > div { height: 100%; background: var(--hmt-main); transition: width .12s linear; }\n\n/* keys */\n.hmt .key .cap { fill: var(--hmt-subalt); stroke: transparent; stroke-width: 0; transition: fill .25s ease-out, stroke .1s; }\n.hmt .key text { fill: var(--hmt-sub); text-anchor: middle; dominant-baseline: middle; font-family: var(--font, \"Roboto Mono\", monospace); pointer-events: none; }\n.hmt .key .sub { font-size: 9px; text-anchor: start; dominant-baseline: auto; opacity: .75; }\n.hmt .key .alt { font-size: 9px; text-anchor: end; dominant-baseline: auto; opacity: .75; }\n.hmt .key .enc-dir { font-size: 10px; }\n.hmt .key .homing { fill: transparent; }\n.hmt .key.homing-key .homing { fill: var(--hmt-bg); }\n.hmt .key .pending-bar { fill: var(--hmt-bg); }\n.hmt .key .badge { display: none; }\n.hmt .key.k-none .cap { fill-opacity: .35; }\n.hmt .key.k-none text { display: none; }\n.hmt .key.through text { opacity: .45; }\n.hmt .key.k-modded .main { fill: var(--hmt-text); }\n.hmt .key.k-dead .main { opacity: .35; }\n\n.hmt .key.pressed .cap { fill: var(--hmt-main); transition: none; }\n.hmt .key.pressed text { fill: var(--hmt-bg); opacity: 1; }\n.hmt .key.pressed .homing { fill: var(--hmt-subalt); }\n.hmt .key.pressed.pending .cap { fill: color-mix(in srgb, var(--hmt-main) 45%, var(--hmt-subalt)); }\n.hmt .key.pressed.hold .cap { fill: var(--hmt-text); }\n.hmt .key.flash-ok .cap { fill: var(--hmt-main); transition: none; }\n.hmt .key.flash-err .cap { fill: var(--hmt-error); transition: none; }\n.hmt .key.flash-ok text, .hmt .key.flash-err text { fill: var(--hmt-bg); }\n\n.hmt .key.hint .cap { stroke: var(--hmt-main); stroke-width: 3; }\n.hmt .key.hint text { fill: var(--hmt-text); }\n.hmt .key.hint-layer .cap { stroke: var(--hmt-main); stroke-width: 2.2; stroke-dasharray: 5 4; }\n.hmt .key.hint-mod .cap { stroke: var(--hmt-text); stroke-width: 2.2; stroke-dasharray: 5 4; }\n.hmt .key.unlock .cap { stroke: var(--hmt-main); stroke-width: 3; fill: color-mix(in srgb, var(--hmt-main) 25%, var(--hmt-subalt)); }\n.hmt .key.unlock.pressed .cap { fill: var(--hmt-main); }\n\n/* hands */\n.hmt .hand .palm, .hmt .hand .finger { fill: var(--hmt-subalt); fill-opacity: .7; stroke: transparent; stroke-width: 0; transition: stroke .1s; }\n.hmt .hand .finger.target { stroke: var(--hmt-main); stroke-width: 3.5; fill: var(--hmt-bg); fill-opacity: 1; }\n.hmt .hand .finger.helper-layer { stroke: var(--hmt-main); stroke-width: 2.5; stroke-dasharray: 5 4; }\n.hmt .hand .finger.helper-mod { stroke: var(--hmt-text); stroke-width: 2.5; stroke-dasharray: 5 4; }\n\n/* monkeytype's own keymap is replaced while a Halcyon is shown */\nbody.halcyon-hide-mt-keymap [data-ui-element=\"keymap\"] { display: none !important; }\n\n/* control pill */\n.hmt-pill { position: fixed; right: 0.8rem; bottom: 0.8rem; z-index: 99999; font-family: var(--font, \"Roboto Mono\", monospace); font-size: 0.75rem; }\n.hmt-pill-btn {\n  all: unset; cursor: pointer; padding: 0.35rem 0.7rem; border-radius: 0.5rem; background: var(--sub-alt-color, #2c2e31);\n  color: var(--sub-color, #646669); opacity: .7; transition: opacity .15s, color .15s;\n}\n.hmt-pill-btn:hover { opacity: 1; color: var(--text-color, #d1d0c5); }\n.hmt-pill[data-state=\"live\"] .hmt-pill-btn { color: var(--main-color, #e2b714); }\n.hmt-menu {\n  position: absolute; right: 0; bottom: calc(100% + 0.5rem); width: 19rem; padding: 0.9rem; border-radius: 0.6rem;\n  background: var(--bg-color, #323437); border: 2px solid var(--sub-alt-color, #2c2e31); color: var(--text-color, #d1d0c5);\n  display: flex; flex-direction: column; gap: 0.55rem; box-shadow: 0 0.5rem 2rem rgba(0, 0, 0, .35);\n}\n.hmt-menu[hidden] { display: none; }\n.hmt-menu-title { color: var(--main-color, #e2b714); font-size: 0.85rem; }\n.hmt-menu-status { color: var(--sub-color, #646669); line-height: 1.4; }\n.hmt-menu-row { display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }\n.hmt-menu select, .hmt-menu input[type=\"range\"] { font: inherit; color: var(--text-color, #d1d0c5); background: var(--sub-alt-color, #2c2e31); border: none; border-radius: 0.35rem; padding: 0.2rem 0.4rem; max-width: 11rem; }\n.hmt-check { display: flex; gap: 0.5rem; align-items: center; cursor: pointer; }\n.hmt-check input { accent-color: var(--main-color, #e2b714); }\n.hmt-btn, .hmt-notice .hmt-btn {\n  all: unset; cursor: pointer; padding: 0.3rem 0.7rem; border-radius: 0.4rem; background: var(--sub-alt-color, #2c2e31);\n  color: var(--text-color, #d1d0c5); font-family: inherit; font-size: 0.75rem; transition: filter .12s;\n}\n.hmt-btn:hover { filter: brightness(1.2); }\n.hmt-btn.primary { background: var(--main-color, #e2b714); color: var(--bg-color, #323437); }\n.hmt-muted { color: var(--sub-color, #646669); }\n";
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
    this.recentPresses = [];   // unlocked: last matrix presses, to learn which key typed a character
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
        for (const p of pressed) {
          if (before.has(p)) continue;
          this.lastPressed = p;
          const rec = this.model.held.get(p);
          if (rec) this.recentPresses = [...this.recentPresses.slice(-7), { pos: p, layer: rec.layer, downAt: rec.downAt }];
        }
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
    const ch = e.key.length === 1 ? e.key : null;
    if (this.matrix) {
      // the matrix poll may see the press a few ms after the DOM event
      if (ch) setTimeout(() => this.#learn(ch, e.code), 60);
      return;
    }
    const expectedChar = this.#nextChar();
    const expected = expectedChar ? this.index.pathFor(expectedChar) : null;
    const hit = this.index.resolveTyped(e.code, ch, expected, [this.view.layer, this.model.defaultLayer]);
    if (!hit) return;
    this.resolved.set(e.code, hit);
    this.lastPressed = hit.pos;
  }

  #learn(ch, code) {
    if (!this.kb || !this.index.learn(ch, code, this.recentPresses.filter((p) => performance.now() - p.downAt < 500))) return;
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

return {  };
})();
})();
