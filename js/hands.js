// Finger assignment for split keyboards and a small two-hands view that shows
// which finger should press the next key (plus the fingers holding layer/modifier keys).

import { keyBounds } from './kle.js';

const FINGER_ORDER = ['index', 'index', 'middle', 'ring', 'pinky'];

/**
 * Assign every key to a hand and finger from the physical layout:
 * per half, columns are counted from the inside (2× index, middle, ring, pinky, pinky…);
 * rotated keys and the last matrix row of each half are thumb keys.
 * Returns { fingers: Map("r,c" -> {hand, finger, row, col}), homing: Set("r,c") }.
 */
export function computeFingers(placed, matrixRows) {
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

export class HandsView {
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
