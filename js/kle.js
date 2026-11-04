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

export function deserializeKle(rows) {
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
export function keyBounds(key) {
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
export function parseVialLayout(definition) {
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
export function parseLayoutLabels(labels) {
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
export function unpackLayoutOptions(value, options) {
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
export function placeKeys(allKeys, choices) {
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
