// End-to-end checks without hardware: protocol (against a mock Vial firmware),
// layout placement, firmware state model, keymap lookups and labels.
// Run: node tools/test-app.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { HidTransport, VialKeyboard } from '../js/hid.js';
import { parseVialLayout, parseLayoutLabels, unpackLayoutOptions, placeKeys } from '../js/kle.js';
import { FirmwareModel, lockedSnapshot } from '../js/state.js';
import { KeymapIndex } from '../js/lookup.js';
import { HOST_LAYOUTS, labelFor, charFor, decode } from '../js/keycodes.js';
import { execFileSync } from 'node:child_process';
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
import { MockVialDevice } from './mock-vial.mjs';
import { computeFingers } from '../js/hands.js';

function xzCompress(bytes) {
  return new Uint8Array(execFileSync(PYTHON, ['-I', '-c', 'import sys,lzma; sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read()))'], { input: Buffer.from(bytes) }));
}
import { parseKeycode } from './keycode-names.mjs';

const demo = JSON.parse(readFileSync(new URL('../demo/halcyon-kyria.json', import.meta.url), 'utf8'));
let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('PASS ', name); } else { failed++; console.log('FAIL ', name, detail); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posOf = (layer, kc) => {
  for (let r = 0; r < demo.keymap[layer].length; r++) {
    for (let c = 0; c < demo.keymap[layer][r].length; c++) if (demo.keymap[layer][r][c] === kc) return r + ',' + c;
  }
  return null;
};

// ---------------------------------------------------------------- protocol
{
  const definitionXz = xzCompress(new TextEncoder().encode(JSON.stringify(demo.definition)));
  writeFileSync(new URL('./fixtures/halcyon-kyria.def.xz', import.meta.url), definitionXz);
  const dev = new MockVialDevice(demo, { counterMax: 5, definitionXz });
  const t = new HidTransport(dev);
  await t.open();
  const kb = new VialKeyboard(t, dev.productName);
  await kb.load();
  check('vial protocol 6', kb.vialProtocol === 6);
  check('definition decoded', kb.definition.matrix.rows === 8 && kb.definition.matrix.cols === 12);
  check('layer count', kb.layerCount === 8);
  check('keymap identical', JSON.stringify(kb.keymap) === JSON.stringify(demo.keymap));
  check('layout options', kb.layoutOptionsValue === demo.layoutOptionsValue, kb.layoutOptionsValue);
  check('encoders read', kb.encoders['0,0'][1] === demo.encoders['0,0'][1]);
  check('settings read', kb.settings.tappingTerm === 200 && kb.settings.permissiveHold === true);
  check('locked with unlock keys', !kb.unlocked && JSON.stringify(kb.unlockKeys) === '[[0,1],[4,1]]', JSON.stringify(kb.unlockKeys));

  dev.press('2,3');
  check('matrix hidden while locked', (await kb.matrixPoll()).length === 0);

  // polling faster than 100 ms must never unlock (firmware resets its counter)
  await kb.unlockStart();
  dev.press('0,1', '4,1');
  for (let i = 0; i < 12; i++) { await sleep(40); await kb.unlockPoll(); }
  check('fast polling does not unlock', !kb.unlocked);
  let res;
  for (let i = 0; i < 20; i++) { await sleep(130); res = await kb.unlockPoll(); if (res.unlocked) break; }
  check('unlock with 130 ms polling', res.unlocked === true);
  dev.release('0,1', '4,1');

  const pressed = await kb.matrixPoll();
  check('matrix after unlock', pressed.length === 1 && pressed[0] === '2,3', JSON.stringify(pressed));
  dev.press('7,11', '0,0');
  const p2 = (await kb.matrixPoll()).sort();
  check('matrix multi-byte columns', JSON.stringify(p2) === JSON.stringify(['0,0', '2,3', '7,11']), JSON.stringify(p2));
  await kb.lock();
  check('lock', (await kb.matrixPoll()).length === 0);
  await t.close();
}

// an unlock left in progress (page reloaded while holding the keys) is finished before loading
{
  const definitionXz = readFileSync(new URL('./fixtures/halcyon-kyria.def.xz', import.meta.url));
  const dev = new MockVialDevice(demo, { counterMax: 3, definitionXz });
  const t = new HidTransport(dev);
  await t.open();
  const kb = new VialKeyboard(t, dev.productName);
  await kb.unlockStart();
  const texts = [];
  setTimeout(() => dev.press('0,1', '4,1'), 300);
  await kb.load((f, what) => texts.push(what));
  check('load finishes a pending unlock first', kb.unlocked && texts.some((s) => s.startsWith('Entsperren')));
  check('keymap complete after pending unlock', kb.layerCount === 8 && JSON.stringify(kb.keymap) === JSON.stringify(demo.keymap));
  await t.close();
}

// ---------------------------------------------------------------- layout
{
  const all = parseVialLayout(demo.definition);
  const opts = parseLayoutLabels(demo.definition.layouts.labels);
  const choices = unpackLayoutOptions(demo.layoutOptionsValue, opts);
  check('layout options unpacked', JSON.stringify(choices) === '[0,1,0,1]', JSON.stringify(choices));
  const none = placeKeys(all, [0, 0, 0, 0]);
  check('kyria base keys', none.keys.length === 50 && none.keys.every((k) => !k.decal), none.keys.length);
  const mods = placeKeys(all, choices);
  check('module encoders shown', mods.keys.filter((k) => k.encoder).length === 4);
  const minX = Math.min(...mods.keys.map((k) => k.x + k.shiftX));
  check('normalized to origin', Math.abs(minX) < 0.6, minX);
}

// ---------------------------------------------------------------- firmware model
{
  const mtEsc = posOf(0, parseKeycode('MT(MOD_LCTL, KC_ESC)'));
  const mo4 = posOf(0, parseKeycode('MO(4)'));
  const m = new FirmwareModel(demo.keymap, { tappingTerm: 200 });
  m.update([mtEsc], 0);
  check('mod-tap pending', m.snapshot().keys.get(mtEsc).role === 'pending' && m.snapshot().mods === 0);
  m.update([mtEsc], 250);
  check('mod-tap becomes Ctrl after tapping term', m.snapshot().mods === 0x01);
  m.update([], 300);
  check('released', m.snapshot().mods === 0 && m.snapshot().keys.size === 0);

  m.update([mo4], 1000);
  check('MO(4) shows layer 4', m.snapshot().displayLayer === 4);
  const r = mtEsc.split(',').map(Number);
  check('resolve on layer 4', m.resolve(...r).layer === 4);
  m.update([], 1100);
  check('back to base', m.snapshot().displayLayer === 0);

  // custom keymap: OSM, LT, tri-layer, TG, DF
  const K = (s) => parseKeycode(s);
  const km = [
    [[K('OSM(MOD_LSFT)'), K('LT(2, KC_SPC)'), K('TL_LOWR'), K('TL_UPPR'), K('TG(1)'), K('KC_A'), K('DF(1)')]],
    [[1, 1, 1, 1, 1, K('KC_B'), K('DF(0)')]],
    [[1, 1, 1, 1, 1, K('KC_C'), 1]],
    [[1, 1, 1, 1, 1, K('KC_D'), 1]],
  ];
  const f = new FirmwareModel(km, { tappingTerm: 200, holdOnOtherKeyPress: true });
  f.update(['0,0'], 0); f.update([], 50);
  check('OSM armed after tap', f.snapshot().oneShotMods === 0x02);
  f.update(['0,5'], 100);
  check('OSM applied to next key', f.snapshot().mods === 0x02 && f.snapshot().oneShotMods === 0);
  f.update([], 150);
  check('OSM consumed', f.snapshot().mods === 0);
  f.update(['0,1'], 200); f.update(['0,1', '0,5'], 230);
  check('hold-on-other-key-press -> LT layer', f.snapshot().keys.get('0,5').layer === 2, JSON.stringify([...f.snapshot().keys]));
  f.update([], 300);
  const g = new FirmwareModel(km, { tappingTerm: 200 });
  g.update(['0,1'], 0); g.update(['0,1', '0,5'], 50);
  check('LT still undecided after roll', g.snapshot().keys.get('0,5').layer === 0);
  g.update(['0,1', '0,5'], 260);
  check('buffered key re-resolved when LT turns hold', g.snapshot().keys.get('0,5').layer === 2 && g.snapshot().displayLayer === 2);
  g.update([], 300);
  check('LT tap leaves base layer', g.snapshot().displayLayer === 0);
  f.update(['0,2', '0,3'], 400);
  check('tri-layer', f.snapshot().displayLayer === 3);
  f.update([], 450);
  f.update(['0,4'], 500); f.update([], 520);
  check('TG(1) toggled', f.snapshot().displayLayer === 1);
  f.update(['0,4'], 600); f.update([], 620);
  check('TG(1) off', f.snapshot().displayLayer === 0);
  f.update(['0,6'], 700); f.update([], 720);
  check('DF(1) sets default layer', f.snapshot().defaultLayer === 1 && f.resolve(0, 5).kc === K('KC_B'));
}

// ---------------------------------------------------------------- lookups & labels
{
  const host = HOST_LAYOUTS['de-mac'];
  const all = parseVialLayout(demo.definition);
  const placed = placeKeys(all, [0, 1, 0, 1]);
  const positions = [...new Set(placed.keys.filter((k) => !k.encoder).map((k) => k.row + ',' + k.col))];
  const keyX = new Map(placed.keys.filter((k) => !k.encoder).map((k) => [k.row + ',' + k.col, k.x + k.shiftX + 0.5]));
  const ctx = { host, tapDances: [] };
  const idx = new KeymapIndex({ keymap: demo.keymap, positions, keyX, centerX: placed.width / 2, ctx }, host, 0);
  const a = idx.pathFor('a');
  check('path a on base layer', a && a.layer === 0 && !a.shift && a.target === posOf(0, parseKeycode('KC_A')));
  const Z = idx.pathFor('Z');
  check('path Z (German: KC_Y + shift)', Z && Z.target === posOf(0, parseKeycode('KC_Y')) && Z.shift && Z.modKeys.length === 1);
  const zShiftSide = keyX.get(Z.modKeys[0]) > placed.width / 2;
  check('shift on opposite hand', zShiftSide === (keyX.get(Z.target) < placed.width / 2));
  const one = idx.pathFor('1');
  check('path 1 via layer 4', one && one.layer === 4 && one.layerKeys.length === 1);

  // "ö" lies on the base layer and on layer 4: locked, the key shown follows hint and preference
  idx.kb.preferred = {};
  const oe = idx.charPaths.get('ö');
  const oeBase = oe.find((p) => p.layer === 0), oeL4 = oe.find((p) => p.layer === 4);
  const oeCode = idx.codeAt(oeBase.pos, 0);
  check('ö on base and layer 4 sends the same code', oeL4 && oeCode && idx.codeAt(oeL4.pos, 4) === oeCode && oeBase.pos !== oeL4.pos);
  check('ö is ambiguous, 1 is not', idx.isAmbiguous('ö') && !idx.isAmbiguous('1'));
  const oePath4 = { target: oeL4.pos, layer: 4 };
  let hit = idx.resolveTyped(oeCode, 'ö', oePath4, [0, 0]);
  check('locked: expected path wins', hit.pos === oeL4.pos && hit.layer === 4);
  const snap = lockedSnapshot({ dom: { codes: new Set([oeCode]), capsLock: false }, index: idx, viewLayer: 0, baseLayer: 0, resolved: new Map([[oeCode, hit]]) });
  check('locked: layer of the resolved key shown', snap.displayLayer === 4 && snap.keys.has(oeL4.pos));
  hit = idx.resolveTyped(oeCode, 'ö', null, [0, 0]);
  check('locked without context: base key', hit.pos === oeBase.pos && hit.layer === 0);

  check('hint before learning: base', idx.pathFor('ö').layer === 0);
  check('learn the layer-4 key for ö', idx.learnPress(oeL4.pos, 4, 0) && idx.kb.preferred['ö'] === '4:' + oeL4.pos);
  check('learn is idempotent', !idx.learnPress(oeL4.pos, 4, 0));
  check('hint follows preference', idx.pathFor('ö').target === oeL4.pos && idx.pathFor('ö').layer === 4);
  hit = idx.resolveTyped(oeCode, 'ö', null, [0, 0]);
  check('locked: preference beats base layer', hit.pos === oeL4.pos && hit.layer === 4);
  check('shift press learns the shifted character only', idx.learnPress(oeBase.pos, 0, 0x02) && idx.kb.preferred['ö'] === '4:' + oeL4.pos
    && idx.kb.preferred['Ö'] === '0:' + oeBase.pos);
  check('learn ignores unambiguous chars', !idx.learnPress(one.target, 4, 0) && !('1' in idx.kb.preferred));
  idx.kb.preferred = {};
  check('space found', !!idx.pathFor(' '));
  check('backspace found', !!idx.pathFor('\b'));
  check('DE: S(KC_7) types /', charFor(0x24, 0x02, host) === '/');
  check('DE mac: Option+L types @', charFor(0x0F, 0x04, host) === '@');
  check('DE win: AltGr+Q types @', charFor(0x14, 0x40, HOST_LAYOUTS['de-win']) === '@');
  check('US: Cmd+C types nothing', charFor(0x06, 0x08, HOST_LAYOUTS.us) === null);
  const lt = labelFor(parseKeycode('LT(3, KC_SPC)'), ctx);
  check('LT label', lt.main === '␣' && lt.sub === 'L3' && lt.dual);
  const mt = labelFor(parseKeycode('MT(MOD_RCTL, KC_QUOTE)'), ctx);
  check('MT label (DE quote key = ä)', mt.main === 'ä' && mt.dual, JSON.stringify(mt));
  check('KC_Y label is z on German', labelFor(parseKeycode('KC_Y'), ctx).main === 'z');
  check('label follows Shift', labelFor(parseKeycode('KC_Y'), ctx, { mods: 0x02 }).main === 'Z');
  check('label follows Shift on symbols (DE 7 -> /)', labelFor(parseKeycode('KC_7'), ctx, { mods: 0x20 }).main === '/');
  check('label follows Option (DE mac L -> @)', labelFor(parseKeycode('KC_L'), ctx, { mods: 0x04 }).main === '@');
  check('label follows Caps', labelFor(parseKeycode('KC_A'), ctx, { mods: 0, caps: true }).main === 'A');
  check('ß is a symbol with ? on shift', labelFor(parseKeycode('KC_MINS'), ctx).sub === '?');
  check('decode OSM', decode(parseKeycode('OSM(MOD_LSFT|MOD_LCTL)')).mods === 0x03);
  check('decode right-hand mods', decode(parseKeycode('MT(MOD_RSFT, KC_J)')).mods === 0x20);
}

// ---------------------------------------------------------------- fingers
{
  const all = parseVialLayout(demo.definition);
  const placed = placeKeys(all.filter((k) => !k.encoder && k.layoutIndex === -1), []);
  const { fingers, homing } = computeFingers(placed, demo.definition.matrix.rows);
  const f = (name) => { const p = posOf(0, parseKeycode(name)); const x = fingers.get(p); return x && x.hand + '-' + x.finger; };
  check('fingers: r = left index', f('KC_R') === 'L-index');
  check('fingers: t = left index (inner column)', f('KC_T') === 'L-index');
  check('fingers: e = left middle', f('KC_E') === 'L-middle');
  check('fingers: s = left ring', f('KC_S') === 'L-ring');
  check('fingers: a = left pinky', f('KC_A') === 'L-pinky');
  check('fingers: o = right ring', f('KC_O') === 'R-ring');
  check('fingers: backspace = right pinky', f('KC_BSPC') === 'R-pinky');
  check('fingers: space on a thumb', /thumb$/.test(f('KC_SPC')));
  check('homing on f and j', homing.has(posOf(0, parseKeycode('KC_F'))) && homing.has(posOf(0, parseKeycode('KC_J'))) && homing.size === 2);
  // Corne: 3x6 + 3 thumbs, different matrix and KLE
  const corne = JSON.parse(readFileSync(new URL('./fixtures/halcyon-corne.vial.json', import.meta.url), 'utf8'));
  const cp = placeKeys(parseVialLayout(corne).filter((k) => !k.encoder && k.layoutIndex === -1), []);
  const cf = computeFingers(cp, corne.matrix.rows).fingers;
  const thumbs = [...cf.values()].filter((x) => x.finger === 'thumb').length;
  check('corne: 6 thumb keys', thumbs === 6, thumbs);
  check('corne: 2 homing keys', computeFingers(cp, corne.matrix.rows).homing.size === 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
