// QMK keycodes as used by Vial protocol >= 6 (QMK's 2022+ keycode layout).
// Decodes 16-bit keycodes from the dynamic keymap into structured actions,
// produces keycap labels, and maps keycodes to the characters the host OS
// layout (US / German) would type.

export const KC_NO = 0x0000;
export const KC_TRNS = 0x0001;

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

export const BASIC = new Map(BASIC_TABLE.map(([hid, name, code, label]) => [hid, { hid, name, code, label }]));

// KeyboardEvent.code -> HID usage. Later entries must not override the preferred
// QMK codes (e.g. KC_VOLU 0xA9 instead of the rarely used 0x80).
export const DOM_CODE_TO_HID = new Map();
for (const [hid, , code] of BASIC_TABLE) {
  if (code && !DOM_CODE_TO_HID.has(code)) DOM_CODE_TO_HID.set(code, hid);
}

// ---------------------------------------------------------------------------
// Modifiers

// QMK 5-bit mod mask (bit4 = right hand) -> 8-bit HID modifier byte.
export function qmkModsToHid(mods) {
  return mods & 0x10 ? (mods & 0x0f) << 4 : mods & 0x0f;
}

// HID modifier byte bits
export const MOD = { LCTL: 0x01, LSFT: 0x02, LALT: 0x04, LGUI: 0x08, RCTL: 0x10, RSFT: 0x20, RALT: 0x40, RGUI: 0x80 };
export const MOD_KEYS = { 0xE0: MOD.LCTL, 0xE1: MOD.LSFT, 0xE2: MOD.LALT, 0xE3: MOD.LGUI, 0xE4: MOD.RCTL, 0xE5: MOD.RSFT, 0xE6: MOD.RALT, 0xE7: MOD.RGUI };

export const MOD_SYMBOLS = IS_MAC
  ? { ctrl: '⌃', shift: '⇧', alt: '⌥', gui: '⌘' }
  : { ctrl: 'Strg', shift: '⇧', alt: 'Alt', gui: 'Win' };
export const MOD_NAMES = IS_MAC
  ? { ctrl: 'Control', shift: 'Shift', alt: 'Option', gui: 'Command' }
  : { ctrl: 'Strg', shift: 'Shift', alt: 'Alt', gui: 'Win' };

// Compact symbol string for an 8-bit HID modifier mask.
export function modsSymbol(hidMods) {
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
export const QK_CAPS_WORD_TOGGLE = 0x7C73;
export const FN_MO13 = 0x7C77;
export const FN_MO23 = 0x7C78;
export const QK_LAYER_LOCK = 0x7C7B;

const RGB_MATRIX = {
  0x7840: 'RGB on', 0x7841: 'RGB off', 0x7842: 'RGB ⏻', 0x7843: 'RGB →', 0x7844: 'RGB ←', 0x7845: 'Hue+', 0x7846: 'Hue−',
  0x7847: 'Sat+', 0x7848: 'Sat−', 0x7849: 'Hell+', 0x784A: 'Hell−', 0x784B: 'Tempo+', 0x784C: 'Tempo−',
};

/**
 * Decode a keycode into { type, ... }.
 * types: none, trns, basic, mods, modtap, layertap, layermod, to, mo, df, tg, osl, osm, tt, pdf,
 *        swap, td, magic, midi, macro, quantum, lighting, kb, unicode, other
 */
export function decode(kc) {
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

export const HOST_LAYOUTS = {
  us: buildLayout('us', 'US (QWERTY)', US_PRINTABLE, null, 'none', false),
  'de-mac': buildLayout('de-mac', 'Deutsch (Mac)', DE_PRINTABLE, DE_MAC_ALT, 'option', true),
  'de-win': buildLayout('de-win', 'Deutsch (Windows/Linux)', DE_PRINTABLE, DE_WIN_ALTGR, 'altgr', true),
};

/** Best-effort detection of the OS keyboard layout via the Keyboard Map API. */
export async function detectHostLayout() {
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
export function charFor(hid, mods, host) {
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

function basicLabel(hid, host) {
  const info = BASIC.get(hid);
  if (MOD_KEYS[hid]) {
    const m = MOD_KEYS[hid];
    return { main: modsSymbol(m), sub: m & 0xF0 ? 'R' : 'L', cls: 'k-mod', desc: modsName(m) };
  }
  const entry = host.chars.get(hid);
  if (entry && hid !== 0x2C && !(hid >= 0x54 && hid <= 0x67 && hid !== 0x64)) {
    const base = entry[0];
    const isLetter = /\p{L}/u.test(base) && base.toUpperCase() !== base;
    if (isLetter) return { main: base.toUpperCase(), cls: 'k-letter', desc: `Buchstabe ${base.toUpperCase()}` };
    return {
      main: base, sub: entry[1] && entry[1] !== base ? entry[1] : undefined, alt: entry[2] || undefined,
      cls: 'k-symbol', desc: `Zeichen ${base}${entry[1] ? ' (⇧ ' + entry[1] + ')' : ''}${entry[2] ? ' (' + MOD_SYMBOLS.alt + ' ' + entry[2] + ')' : ''}`,
    };
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
 * Keycap label for a keycode. ctx: { host, tapDances, customKeycodes }
 * Returns { main, sub?, cls, desc }.
 */
export function labelFor(kc, ctx) {
  const d = decode(kc);
  const host = ctx.host;
  switch (d.type) {
    case 'none': return { main: '', cls: 'k-none', desc: 'Keine Funktion' };
    case 'trns': return { main: '▽', cls: 'k-trns', desc: 'Transparent (Layer darunter)' };
    case 'basic': return basicLabel(d.base, host);
    case 'mods': {
      const ch = charFor(d.base, d.mods, host);
      const baseL = basicLabel(d.base, host);
      if (ch && ch.trim()) return { main: ch, cls: 'k-symbol', desc: `${modsName(d.mods)} + ${baseL.main} → ${ch}` };
      return { main: modsSymbol(d.mods) + baseL.main, cls: 'k-combo', desc: `${modsName(d.mods)} + ${baseL.desc}` };
    }
    case 'modtap': {
      const tap = basicLabel(d.base, host);
      return { main: tap.main, sub: modsSymbol(d.mods), cls: 'k-dual ' + tap.cls, dual: true,
        desc: `Tippen: ${tap.desc} · Halten: ${modsName(d.mods)}` };
    }
    case 'layertap': {
      const tap = basicLabel(d.base, host);
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
        const tap = labelFor(td.onTap, ctx);
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
export function tapKeycode(kc, ctx) {
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
