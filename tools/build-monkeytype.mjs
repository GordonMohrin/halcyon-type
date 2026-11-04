// Bundles monkeytype/overlay.js and its ES-module imports into one classic script and writes
//   monkeytype/extension/            unpacked Chrome extension (Manifest V3, content script in the page world)
//   monkeytype/halcyon-monkeytype.user.js   userscript for Tampermonkey/Violentmonkey
// Run: node tools/build-monkeytype.mjs

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  out += `// ---- ${relative(root, file)}\nconst ${m.id} = (() => {\n${imports}\n${src}\nreturn { ${m.exports.join(', ')} };\n})();\n`;
}

const banner = `/*!
 * Halcyon für monkeytype ${VERSION} — live Vial keyboard for monkeytype.com
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
writeFileSync(resolve(extDir, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Halcyon für monkeytype',
  version: VERSION,
  description: 'Zeigt deine Vial-Tastatur (splitkb Halcyon) live in monkeytype: Layer, Modifier, nächste Taste, Finger.',
  content_scripts: [{
    matches: ['https://monkeytype.com/*'],
    js: ['halcyon-monkeytype.js'],
    world: 'MAIN',
    run_at: 'document_idle',
  }],
}, null, 2) + '\n');

// ------------------------------------------------------------------ userscript
const header = `// ==UserScript==
// @name         Halcyon für monkeytype
// @namespace    https://github.com/GordonMohrin/halcyon-type
// @version      ${VERSION}
// @description  Live Vial keyboard (layers, modifiers, next key, fingers) for splitkb Halcyon on monkeytype.com
// @match        https://monkeytype.com/*
// @grant        none
// @run-at       document-idle
// @license      GPL-3.0-or-later
// ==/UserScript==
`;
writeFileSync(resolve(root, 'monkeytype/halcyon-monkeytype.user.js'), header + bundle);

console.log(`built ${order.length} modules, ${(bundle.length / 1024).toFixed(0)} KB -> monkeytype/extension/ and monkeytype/halcyon-monkeytype.user.js`);
