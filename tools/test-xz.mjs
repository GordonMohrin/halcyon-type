// Round-trip test for js/xz.js: Python's lzma module compresses the fixtures,
// xzDecompress() must restore every byte.
//
// Run from the halcyon-type folder:  node tools/test-xz.mjs
// Fixtures are written to a temp folder (override with XZ_FIXTURE_DIR / VIAL_JSON).

import { execFileSync } from 'node:child_process';
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { xzDecompress } from '../js/xz.js';

const FIXTURE_DIR = process.env.XZ_FIXTURE_DIR || join(tmpdir(), 'halcyon-xz-fixtures');
const VIAL_JSON = process.env.VIAL_JSON || fileURLToPath(new URL('./fixtures/halcyon-kyria.vial.json', import.meta.url));

// Python writes <name>.raw / <name>.<variant>.xz files plus manifest.json.
// Argument 1: output folder, argument 2: Vial JSON source.
const PYTHON_FIXTURES = String.raw`
import json, lzma, os, random, sys

out_dir, vial_path = sys.argv[1], sys.argv[2]

def save(name, data):
    with open(os.path.join(out_dir, name), 'wb') as f:
        f.write(data)
    return name

# Minified exactly like Vial does before compressing vial.json
with open(vial_path, encoding='utf-8') as f:
    vial = json.dumps(json.loads(f.read()), separators=(',', ':')).encode('utf-8')

rng = random.Random(20261104)
line = b'Halcyon Kyria: the quick brown fox jumps over the lazy dog 0123456789\n'
repetitive = (line * (2 * 1024 * 1024 // len(line) + 1))[:2 * 1024 * 1024]
vocab = ('key layer macro combo tap hold mod shift ctrl alt gui encoder matrix '
         'row col rgb oled split kyria halcyon vial qmk keymap tapdance').encode().split()
words = b' '.join(rng.choice(vocab) for _ in range(190000))[:1024 * 1024]
# Random blocks (stored as uncompressed chunks) between text (LZMA chunks); r[0] repeats,
# so later LZMA matches reach back into data that came from uncompressed chunks
r = [rng.randbytes(200 * 1024) for _ in range(3)]
t = [words[i * 131072:(i + 1) * 131072] for i in range(4)]
mixed = r[0] + t[0] + r[1] + t[1] + r[0] + t[2] + r[2] + t[3]

inputs = {
    'vial-json': vial,
    'empty': b'',
    'one-byte': b'\x42',
    'repetitive-2mb': repetitive,
    'random-300kb': rng.randbytes(300 * 1024),
    'words-1mb': words,
    'mixed-1.3mb': mixed,
}
variants = [
    ('default', {}),
    ('preset9e', {'preset': 9 | lzma.PRESET_EXTREME}),
    ('crc32', {'check': lzma.CHECK_CRC32}),
    ('nocheck', {'check': lzma.CHECK_NONE}),
    ('sha256', {'check': lzma.CHECK_SHA256}),
    ('alone', {'format': lzma.FORMAT_ALONE}),
]

cases = []
for iname, data in inputs.items():
    raw = save(iname + '.raw', data)
    for vname, kwargs in variants:
        comp = lzma.compress(data, **kwargs)
        assert lzma.decompress(comp) == data
        ext = 'lzma' if vname == 'alone' else 'xz'
        cases.append({'name': f'{iname} / {vname}', 'input': save(f'{iname}.{vname}.{ext}', comp), 'expected': raw})

vial_xz = lzma.compress(vial)
tail = words[:5000]
cases.append({'name': 'concatenated streams + padding',
              'input': save('concat.xz', vial_xz + bytes(8) + lzma.compress(tail, check=lzma.CHECK_CRC32)),
              'expected': save('concat.raw', vial + tail)})
cases.append({'name': 'trailing bytes ignored',
              'input': save('trailing.xz', vial_xz + b'\xff' * 29), 'expected': 'vial-json.raw'})

# Error cases: xzDecompress must throw an Error containing 'error'
corrupt = bytearray(vial_xz)
corrupt[len(corrupt) // 2] ^= 0x55

def bad_check(xz, check_size):
    # Flip one bit of the (single) block's check field, which sits right before the index
    x = bytearray(xz)
    index_size = (int.from_bytes(x[-8:-4], 'little') + 1) * 4
    x[len(x) - 12 - index_size - check_size] ^= 0x01
    return bytes(x)

bcj =lzma.compress(vial, filters=[{'id': lzma.FILTER_X86}, {'id': lzma.FILTER_LZMA2}])
cases += [
    {'name': 'error: BCJ filter', 'input': save('bcj.xz', bcj), 'error': 'unsupported filter'},
    {'name': 'error: truncated', 'input': save('truncated.xz', vial_xz[:len(vial_xz) // 2]), 'error': 'truncated'},
    {'name': 'error: corrupt byte', 'input': save('corrupt.xz', bytes(corrupt)), 'error': ''},
    {'name': 'error: wrong CRC64', 'input': save('bad-crc64.xz', bad_check(vial_xz, 8)), 'error': 'CRC64 mismatch'},
    {'name': 'error: wrong CRC32', 'input': save('bad-crc32.xz',
        bad_check(lzma.compress(vial, check=lzma.CHECK_CRC32), 4)), 'error': 'CRC32 mismatch'},
    {'name': 'error: uncompressed JSON', 'input': save('plain.json', vial), 'error': 'neither XZ nor LZMA'},
    {'name': 'error: empty input', 'input': save('empty-input.bin', b''), 'error': 'neither XZ nor LZMA'},
]

with open(os.path.join(out_dir, 'manifest.json'), 'w') as f:
    json.dump(cases, f, indent=1)
`;

mkdirSync(FIXTURE_DIR, { recursive: true });
execFileSync(PYTHON, ['-I', '-c', PYTHON_FIXTURES, FIXTURE_DIR, VIAL_JSON], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
const cases = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

function readBytes(name) {
  const b = readFileSync(join(FIXTURE_DIR, name));
  return new Uint8Array(b.buffer, b.byteOffset, b.length); // plain Uint8Array, as in the browser
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

let failures = 0;
for (const c of cases) {
  const input = readBytes(c.input);
  let result;
  let error;
  const t0 = performance.now();
  try {
    result = xzDecompress(input);
  } catch (e) {
    error = e;
  }
  const ms = (performance.now() - t0).toFixed(1);

  let ok;
  let detail;
  if ('error' in c) {
    ok = error instanceof Error && error.message.includes(c.error);
    detail = error ? `threw "${error.message}"` : 'did not throw';
  } else if (error) {
    ok = false;
    detail = `threw "${error.message}"`;
  } else {
    const expected = readBytes(c.expected);
    const diff = firstDifference(result, expected);
    ok = diff === -1;
    detail = `${input.length} -> ${result.length} bytes`;
    if (!ok) detail += `, expected ${expected.length} bytes, first difference at byte ${diff}`;
  }

  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(34)} ${detail} (${ms} ms)`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
