#!/usr/bin/env node
// Prints the debugfs commands that copy the app, its admin frontend and its runtime dependencies into the
// test image's rootfs: `node scripts/image-commands.js > build/debugfs.cmd`.
// debugfs has no recursive copy, so every directory is a `mkdir` and every file a `write`.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP = '/opt/vendo5';
const UI_SRC = 'legacy/wifi5-soft/frontend-decrypted/public';
const UI_DIRS = ['main', 'nav']; // the login page and the admin shell; client/sub/apk/ppoe stay out
const UI_ROOT_FILES = /\.(js|ico)$/; // socket.io.js and friends sit next to the page folders

// Every regular file under dir, as paths relative to dir (symlinks are skipped: debugfs would copy the target's name only).
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// entries: [{ src, dest }] -> debugfs lines, every parent directory created once, parents first.
function commands(entries) {
  const dirs = new Set();
  for (const { dest } of entries) {
    for (let d = path.posix.dirname(dest); d !== '/' && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
  }
  const mk = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).map((d) => `mkdir ${d}`);
  return [...mk, ...entries.map(({ src, dest }) => `write ${src} ${dest}`)];
}

function entriesFor(root) {
  const out = [];
  const add = (srcDir, destDir, files) => files.forEach((f) => out.push({ src: path.join(srcDir, f), dest: path.posix.join(destDir, f.split(path.sep).join('/')) }));
  add(root, APP, ['main.js', 'package.json', 'package-lock.json']);
  add(root, APP, walk(root, 'lib'));
  add(root, APP, walk(root, 'config').filter((f) => f.endsWith('.json')));
  add(root, APP, walk(root, 'public/theme'));
  const ui = path.join(root, UI_SRC);
  add(ui, `${APP}/ui`, fs.readdirSync(ui, { withFileTypes: true }).filter((e) => e.isFile() && UI_ROOT_FILES.test(e.name)).map((e) => e.name));
  for (const d of UI_DIRS) add(ui, `${APP}/ui`, walk(ui, d));
  // runtime dependencies only (socket.io and what it needs), as npm resolves them
  const deps = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' }).split('\n').filter((p) => p.startsWith(path.join(root, 'node_modules') + path.sep));
  for (const d of [...new Set(deps)]) add(root, APP, walk(root, path.relative(root, d)));
  const seen = new Set(); // nested node_modules are walked once through their parent and again as their own entry
  return out.filter((e) => !seen.has(e.dest) && seen.add(e.dest));
}

module.exports = { walk, commands, entriesFor };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  process.stdout.write(commands(entriesFor(root)).join('\n') + '\n');
}
