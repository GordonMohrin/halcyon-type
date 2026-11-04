// QMK keycode name -> number (dev tooling only: demo data and tests).

import { BASIC } from '../js/keycodes.js';

const NAMES = new Map();
for (const { hid, name } of BASIC.values()) NAMES.set(name, hid);

const ALIASES = {
  KC_ENTER: 'KC_ENT', KC_ESCAPE: 'KC_ESC', KC_BACKSPACE: 'KC_BSPC', KC_SPACE: 'KC_SPC', KC_MINUS: 'KC_MINS',
  KC_EQUAL: 'KC_EQL', KC_QUOTE: 'KC_QUOT', KC_GRAVE: 'KC_GRV', KC_COMMA: 'KC_COMM', KC_SLASH: 'KC_SLSH',
  KC_SEMICOLON: 'KC_SCLN', KC_LEFT_BRACKET: 'KC_LBRC', KC_RIGHT_BRACKET: 'KC_RBRC', KC_BACKSLASH: 'KC_BSLS',
  KC_SCROLL_LOCK: 'KC_SCRL', KC_PAUSE: 'KC_PAUS', KC_RIGHT: 'KC_RGHT', KC_APPLICATION: 'KC_APP', KC_DELETE: 'KC_DEL',
  KC_INSERT: 'KC_INS', KC_PAGE_UP: 'KC_PGUP', KC_PAGE_DOWN: 'KC_PGDN', KC_CAPS_LOCK: 'KC_CAPS', KC_PRINT_SCREEN: 'KC_PSCR',
  KC_LEFT_SHIFT: 'KC_LSFT', KC_RIGHT_SHIFT: 'KC_RSFT', KC_LEFT_CTRL: 'KC_LCTL', KC_RIGHT_CTRL: 'KC_RCTL',
  KC_LEFT_ALT: 'KC_LALT', KC_RIGHT_ALT: 'KC_RALT', KC_LEFT_GUI: 'KC_LGUI', KC_RIGHT_GUI: 'KC_RGUI', KC_ALGR: 'KC_RALT',
  KC_LCMD: 'KC_LGUI', KC_RCMD: 'KC_RGUI', KC_LOPT: 'KC_LALT', KC_ROPT: 'KC_RALT',
};
for (const [a, b] of Object.entries(ALIASES)) NAMES.set(a, NAMES.get(b));

const SHIFTED = {
  KC_TILD: 'KC_GRV', KC_EXLM: 'KC_1', KC_AT: 'KC_2', KC_HASH: 'KC_3', KC_DLR: 'KC_4', KC_PERC: 'KC_5', KC_CIRC: 'KC_6',
  KC_AMPR: 'KC_7', KC_ASTR: 'KC_8', KC_LPRN: 'KC_9', KC_RPRN: 'KC_0', KC_UNDS: 'KC_MINS', KC_PLUS: 'KC_EQL',
  KC_LCBR: 'KC_LBRC', KC_RCBR: 'KC_RBRC', KC_PIPE: 'KC_BSLS', KC_COLN: 'KC_SCLN', KC_DQUO: 'KC_QUOT', KC_DQT: 'KC_QUOT',
  KC_LABK: 'KC_COMM', KC_RABK: 'KC_DOT', KC_QUES: 'KC_SLSH',
};
for (const [a, b] of Object.entries(SHIFTED)) NAMES.set(a, 0x0200 | NAMES.get(b));

const SPECIAL = {
  _______: 0x0001, KC_TRNS: 0x0001, KC_TRANSPARENT: 0x0001, XXXXXXX: 0x0000, KC_NO: 0x0000,
  QK_BOOT: 0x7C00, QK_REBOOT: 0x7C01, QK_CLEAR_EEPROM: 0x7C03, CW_TOGG: 0x7C73, QK_CAPS_WORD_TOGGLE: 0x7C73,
  TL_LOWR: 0x7C77, TL_UPPR: 0x7C78, QK_REP: 0x7C79, QK_AREP: 0x7C7A, QK_LLCK: 0x7C7B, QK_GESC: 0x7C16,
  RM_ON: 0x7840, RM_OFF: 0x7841, RM_TOGG: 0x7842, RM_NEXT: 0x7843, RM_PREV: 0x7844, RM_HUEU: 0x7845, RM_HUED: 0x7846,
  RM_SATU: 0x7847, RM_SATD: 0x7848, RM_VALU: 0x7849, RM_VALD: 0x784A, RM_SPDU: 0x784B, RM_SPDD: 0x784C,
};
for (const [a, v] of Object.entries(SPECIAL)) NAMES.set(a, v);

const MODS = {
  MOD_LCTL: 0x01, MOD_LSFT: 0x02, MOD_LALT: 0x04, MOD_LGUI: 0x08, MOD_RCTL: 0x11, MOD_RSFT: 0x12, MOD_RALT: 0x14,
  MOD_RGUI: 0x18, MOD_HYPR: 0x0F, MOD_MEH: 0x07,
};
const MOD_FUNCS = {
  LCTL: 0x01, C: 0x01, LSFT: 0x02, S: 0x02, LALT: 0x04, A: 0x04, LOPT: 0x04, LGUI: 0x08, G: 0x08, LCMD: 0x08,
  RCTL: 0x11, RSFT: 0x12, RALT: 0x14, ALGR: 0x14, ROPT: 0x14, RGUI: 0x18, RCMD: 0x18, HYPR: 0x0F, MEH: 0x07,
};
const MT_ALIASES = {
  LCTL_T: 0x01, LSFT_T: 0x02, LALT_T: 0x04, LGUI_T: 0x08, RCTL_T: 0x11, RSFT_T: 0x12, RALT_T: 0x14, RGUI_T: 0x18,
  LOPT_T: 0x04, LCMD_T: 0x08, ROPT_T: 0x14, RCMD_T: 0x18, CTL_T: 0x01, SFT_T: 0x02, ALT_T: 0x04, GUI_T: 0x08,
  HYPR_T: 0x0F, MEH_T: 0x07, ALL_T: 0x0F,
};

function parseMods(s) {
  return s.split('|').map((m) => {
    const v = MODS[m.trim()];
    if (v === undefined) throw new Error('unknown mod ' + m);
    return v;
  }).reduce((a, b) => a | b, 0);
}

/** Parse a QMK keycode expression such as "LT(3, KC_SPC)" or "MT(MOD_LCTL, KC_ESC)". */
export function parseKeycode(expr) {
  const s = expr.replace(/\s+/g, '');
  if (NAMES.has(s)) return NAMES.get(s);
  const m = s.match(/^([A-Z_0-9]+)\((.*)\)$/);
  if (!m) throw new Error('unknown keycode ' + expr);
  const [, fn, inner] = m;
  const args = splitArgs(inner);
  const layer = () => Number(args[0]);
  switch (fn) {
    case 'MO': return 0x5220 | layer();
    case 'TO': return 0x5200 | layer();
    case 'DF': return 0x5240 | layer();
    case 'TG': return 0x5260 | layer();
    case 'OSL': return 0x5280 | layer();
    case 'TT': return 0x52C0 | layer();
    case 'PDF': return 0x52E0 | layer();
    case 'OSM': return 0x52A0 | parseMods(args[0]);
    case 'LT': return 0x4000 | (layer() << 8) | (parseKeycode(args[1]) & 0xFF);
    case 'LM': return 0x5000 | (layer() << 5) | parseMods(args[1]);
    case 'MT': return 0x2000 | (parseMods(args[0]) << 8) | (parseKeycode(args[1]) & 0xFF);
    case 'TD': return 0x5700 | Number(args[0]);
    default:
      if (MT_ALIASES[fn] !== undefined) return 0x2000 | (MT_ALIASES[fn] << 8) | (parseKeycode(args[0]) & 0xFF);
      if (MOD_FUNCS[fn] !== undefined) {
        const inner = parseKeycode(args[0]);
        return ((((inner >> 8) & 0x1F) | MOD_FUNCS[fn]) << 8) | (inner & 0xFF);
      }
      if (/^LT\d+$/.test(fn)) return 0x4000 | (Number(fn.slice(2)) << 8) | (parseKeycode(args[0]) & 0xFF);
      throw new Error('unknown keycode function ' + fn);
  }
}

function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function readLenientJson(text) {
  return JSON.parse(text.replace(/\/\/[^\n]*/g, '').replace(/,(\s*[\]}])/g, '$1'));
}
