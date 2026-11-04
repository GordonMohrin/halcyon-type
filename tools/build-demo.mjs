// Builds demo/halcyon-kyria.json from splitkb's Vial files for the Halcyon Kyria:
// the same data the app reads over WebHID, so the demo exercises the real code path.
// Run: node tools/build-demo.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { parseKeycode, readLenientJson } from './keycode-names.mjs';

const dir = new URL('./fixtures/', import.meta.url);
const vial = JSON.parse(readFileSync(new URL('halcyon-kyria.vial.json', dir), 'utf8'));
const keymapJson = readLenientJson(readFileSync(new URL('halcyon-kyria.keymap.json', dir), 'utf8'));
const info = JSON.parse(readFileSync(new URL('halcyon-kyria.info.json', dir), 'utf8'));

const LAYERS = 8; // DYNAMIC_KEYMAP_LAYER_COUNT in splitkb's vial_hlc config.h
const { rows, cols } = vial.matrix;
const order = Object.values(info.layouts)[0].layout.map((k) => k.matrix);

const keymap = [];
for (let l = 0; l < LAYERS; l++) {
  const layer = Array.from({ length: rows }, () => new Array(cols).fill(l === 0 ? 0 : 1));
  const src = keymapJson.layers[l];
  if (src) {
    if (src.length !== order.length) throw new Error(`layer ${l}: ${src.length} keys, layout has ${order.length}`);
    src.forEach((name, i) => { const [r, c] = order[i]; layer[r][c] = parseKeycode(name); });
  }
  keymap.push(layer);
}
// Module buttons (encoder push etc.) are not in the LAYOUT macro; give them something visible.
keymap[0][0][7] = parseKeycode('KC_MUTE');
keymap[0][4][7] = parseKeycode('KC_MPLY');

const encoders = {};
for (let l = 0; l < LAYERS; l++) {
  for (let i = 0; i < 4; i++) {
    encoders[`${l},${i}`] = l === 0
      ? (i % 2 ? [parseKeycode('KC_PGDN'), parseKeycode('KC_PGUP')] : [parseKeycode('KC_VOLD'), parseKeycode('KC_VOLU')])
      : [1, 1];
  }
}

// Layout options: [soldered enc. left, module left, soldered enc. right, module right]; last option = lowest bit.
const choices = [0, 1, 0, 1]; // both Halcyon modules set to "Encoder"
const layoutOptionsValue = choices.reduce((v, c) => (v << 1) | c, 0);

const demo = {
  name: 'Halcyon Kyria (Demo)',
  uid: 'demo-halcyon-kyria',
  definition: vial,
  keymap,
  layerCount: LAYERS,
  encoders,
  settings: { tappingTerm: 200, permissiveHold: false, holdOnOtherKeyPress: false, oneshotTimeout: 0, tappingToggle: 5 },
  tapDances: [],
  layoutOptionsValue,
};
writeFileSync(new URL('../demo/halcyon-kyria.json', import.meta.url), JSON.stringify(demo));
console.log(`demo/halcyon-kyria.json: ${LAYERS} layers, ${rows}x${cols} matrix, layout options 0b${layoutOptionsValue.toString(2)}`);
