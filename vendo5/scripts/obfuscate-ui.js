#!/usr/bin/env node
// Obfuscates our own app-logic JS the same way the original firmware protected the equivalent files
// (javascript-obfuscator.io, confirmed by reverse-engineering the original's nav/main/sub/client script
// files earlier in this project). Scope matches the original exactly: only */script/*.js under main, nav,
// sub, client - never third-party libraries (jQuery, DataTables, Bootstrap, md5.js, socket.io, jquery.terminal,
// newTheme's webpack bundle) and never server-side code (that's a separate, not-yet-decided piece - see
// docs/BUILD-ENCRYPTION.md).
//
// Output goes to build/ui-obfuscated/ (never overwrites the readable source under legacy/...-decrypted/,
// which stays the development copy). Not wired into build-image.sh yet: image-commands.js still ships the readable
// source until the obfuscated output has been checked in a browser.
//
// Usage: node scripts/obfuscate-ui.js
const fs = require('node:fs');
const path = require('node:path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'legacy/wifi5-soft/frontend-decrypted/public');
const OUT = path.join(ROOT, 'build/ui-obfuscated');
const DIRS = ['main', 'nav', 'sub', 'client'];

// Moderate preset: real protection against casual reading/copying, without the two options
// (selfDefending, debugProtection) that are known to break under some browser/devtools combinations -
// not worth the functional risk on a kiosk device nobody can walk over and fix by hand.
const OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  deadCodeInjection: false, // dropped: too slow for this many files at this size, stringArray+controlFlowFlattening already give real protection
  deadCodeInjectionThreshold: 0.4,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false, // would break cross-file globals like socketIO, toastada, dateFormat, hexMD5
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false, // live-test.py's "no JavaScript error" checks read console output; keep it
};

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

let n = 0;
for (const top of DIRS) {
  const scriptDir = path.join(SRC, top, 'script');
  if (!fs.existsSync(scriptDir)) continue;
  for (const file of walk(scriptDir)) {
    const rel = path.relative(SRC, file);
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const src = fs.readFileSync(file, 'utf8');
    // shortcut: controlFlowFlattening is exponential-ish in file size; a handful of files here are >1MB
    // (vouchers.js, credit.js, ticket.js) and never finish at the normal settings. Past this size, string-array
    // obfuscation + identifier renaming still give real protection without that cost; upgrade if these files
    // get minified/split first (most of their size is likely unminified boilerplate, not real complexity).
    const big = src.length > 300000;
    const opts = big ? { ...OPTIONS, controlFlowFlattening: false } : OPTIONS;
    const result = JavaScriptObfuscator.obfuscate(src, opts).getObfuscatedCode();
    fs.writeFileSync(dest, result);
    if (big) console.log(`  (large file, lighter settings: ${rel}, ${(src.length / 1024).toFixed(0)}KB)`);
    n++;
  }
}
console.log(`obfuscated ${n} app-logic file(s) under main/nav/sub/client script/ -> ${path.relative(ROOT, OUT)}`);
