#!/usr/bin/env node
// Build the update archive the admin's "Software Up/Down" and "System Update" install:
//   node scripts/make-update.js [out.tar.gz]        (default build/vendo5-update.tar.gz)
// Same file set as the image build: app, config, theme, admin frontend (main+nav) and production node_modules.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { entriesFor } = require('./image-commands');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'build', 'vendo5-update.tar.gz'));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo5-stage-'));
try {
  const entries = entriesFor(root);
  for (const { src, dest } of entries) {
    const to = path.join(stage, dest.replace(/^\/opt\/vendo5\//, ''));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(src, to);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('tar', ['-czf', out, '-C', stage, '.']);
  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  console.log(`${out}  ${entries.length} files, ${mb} MB, version ${require(path.join(root, 'package.json')).version}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
