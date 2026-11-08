// Bundles monkeytype/overlay.js and its ES-module imports into one classic script and writes
//   monkeytype/extension/            unpacked Chrome extension (Manifest V3, content script in the page world)
//   monkeytype/halcyon-monkeytype.user.js   userscript for Tampermonkey/Violentmonkey
//   dist/ergo-keyboard-for-monkeytype-<version>.zip   package for the extension stores
// Run: node tools/build-monkeytype.mjs

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './make-icons.mjs';

const NAME = 'Ergo Keyboard for Monkeytype';
const DESCRIPTION = 'Shows your Vial keyboard live in monkeytype: layers, modifiers, next key and fingers.';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(resolve(root, 'monkeytype/version.json'), 'utf8')).version;

// ------------------------------------------------------------------ tiny ES module bundler
const modules = new Map();
const order = [];

function load(file) {
  if (modules.has(file)) return;
  let src = readFileSync(file, 'utf8');
  const deps = [];
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm, (_, names, from) => {
    deps.push({ names: names.split(',').map((n) => n.trim()).filter(Boolean), file: resolve(dirname(file), from) });
    return '';
  });
  if (/^\s*import\s/m.test(src)) throw new Error(`${relative(root, file)}: unsupported import syntax`);
  const exports = [];
  src = src.replace(/^export\s+(async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm, (_, kw, name) => {
    exports.push(name);
    return `${kw} ${name}`;
  });
  if (/^\s*export\s/m.test(src)) throw new Error(`${relative(root, file)}: unsupported export syntax`);
  modules.set(file, { src, deps, exports, id: null });
  for (const d of deps) load(d.file);
  modules.get(file).id = '__m' + order.length;
  order.push(file);
}

const entry = resolve(root, 'monkeytype/overlay.js');
load(entry);

const css = readFileSync(resolve(root, 'monkeytype/overlay.css'), 'utf8');
const demo = readFileSync(resolve(root, 'demo/halcyon-kyria.json'), 'utf8');

let out = '';
for (const file of order) {
  const m = modules.get(file);
  const imports = m.deps.map((d) => {
    const dep = modules.get(d.file);
    const binds = d.names.map((n) => {
      const [name, alias] = n.split(/\s+as\s+/);
      if (!dep.exports.includes(name)) throw new Error(`${relative(root, file)} imports missing ${name} from ${relative(root, d.file)}`);
      return alias ? `${name}: ${alias}` : name;
    });
    return `const { ${binds.join(', ')} } = ${dep.id};`;
  }).join('\n');
  let src = m.src;
  if (file === entry) {
    src = src.replace('/*DEMO_DATA*/ null', demo).replace("/*CSS_TEXT*/ ''", JSON.stringify(css));
  }
  out += `// ---- ${relative(root, file).replaceAll('\\', '/')}\nconst ${m.id} = (() => {\n${imports}\n${src}\nreturn { ${m.exports.join(', ')} };\n})();\n`;
}

const banner = `/*!
 * ${NAME} ${VERSION} — live Vial keyboard for monkeytype.com
 * https://github.com/GordonMohrin/halcyon-type
 * Copyright (C) 2026 Gordon Mohrin. License: GPL-3.0-or-later (see LICENSE).
 * Keymap look and behavior adapted from monkeytype (https://github.com/monkeytypegame/monkeytype, GPL-3.0).
 */`;
const bundle = `${banner}\n(() => {\n'use strict';\n${out}})();\n`;

// ------------------------------------------------------------------ extension
const extDir = resolve(root, 'monkeytype/extension');
mkdirSync(extDir, { recursive: true });
writeFileSync(resolve(extDir, 'halcyon-monkeytype.js'), bundle);
copyFileSync(resolve(root, 'LICENSE'), resolve(extDir, 'LICENSE'));
const iconSizes = [16, 32, 48, 128];
mkdirSync(resolve(extDir, 'icons'), { recursive: true });
for (const s of iconSizes) copyFileSync(resolve(root, `monkeytype/icons/icon-${s}.png`), resolve(extDir, `icons/icon-${s}.png`));
writeFileSync(resolve(extDir, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: NAME,
  version: VERSION,
  description: DESCRIPTION,
  homepage_url: 'https://github.com/GordonMohrin/halcyon-type',
  icons: Object.fromEntries(iconSizes.map((s) => [s, `icons/icon-${s}.png`])),
  content_scripts: [{
    matches: ['https://monkeytype.com/*'],
    js: ['halcyon-monkeytype.js'],
    world: 'MAIN',
    run_at: 'document_idle',
  }],
}, null, 2) + '\n');

// ------------------------------------------------------------------ userscript
const header = `// ==UserScript==
// @name         ${NAME}
// @namespace    https://github.com/GordonMohrin/halcyon-type
// @version      ${VERSION}
// @description  ${DESCRIPTION}
// @match        https://monkeytype.com/*
// @grant        none
// @run-at       document-idle
// @license      GPL-3.0-or-later
// ==/UserScript==
`;
writeFileSync(resolve(root, 'monkeytype/halcyon-monkeytype.user.js'), header + bundle);

// ------------------------------------------------------------------ store package
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const packed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(0x00210000, 10); // fixed timestamp (1980-01-01) for reproducible builds
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); head.copy(dir, 8, 6, 30);
    dir.writeUInt32LE(offset, 42);
    local.push(head, nameBuf, packed);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const files = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(resolve(dir, e.name), prefix + e.name + '/') : [[prefix + e.name, readFileSync(resolve(dir, e.name))]]);
const distDir = resolve(root, 'dist');
mkdirSync(distDir, { recursive: true });
const zipName = `ergo-keyboard-for-monkeytype-${VERSION}.zip`;
writeFileSync(resolve(distDir, zipName), zip(files(extDir).sort(([a], [b]) => a.localeCompare(b))));

console.log(`built ${order.length} modules, ${(bundle.length / 1024).toFixed(0)} KB -> monkeytype/extension/, monkeytype/halcyon-monkeytype.user.js, dist/${zipName}`);
