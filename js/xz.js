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
export function xzDecompress(bytes) {
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
