const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const LIMIT = 200 * 1024 * 1024;
const SLOW = { timeout: 10 * 60000 };

const listTree = (dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push({ p, e });
    if (e.isDirectory()) out.push(...listTree(p));
  }
  return out;
};

// Replace the installed app with the tree in a .tar.gz. Every check happens before the swap, and the old tree is
// kept as <appDir>.prev, so a bad archive never leaves the machine without an app. runCommand(argv) -> stdout.
function applyUpdate({ archive, appDir, runCommand }) {
  const staging = `${appDir}.new`;
  const prev = `${appDir}.prev`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    const names = runCommand(['tar', '-tzf', archive], SLOW).split('\n').map((l) => l.trim()).filter(Boolean);
    if (!names.length || names.length > 200000) return { ok: false, error: 'Not an update archive' };
    for (const n of names) {
      if (n.startsWith('/') || n.split('/').some((s) => s === '..')) return { ok: false, error: 'Unsafe path in the archive' };
    }
    const norm = names.map((n) => n.replace(/^\.\//, ''));
    if (!norm.includes('main.js') || !norm.includes('package.json')) return { ok: false, error: 'The archive has no main.js and package.json at its top' };
    fs.mkdirSync(staging, { recursive: true });
    runCommand(['tar', '-xzf', archive, '-C', staging], SLOW);
    for (const { p, e } of listTree(staging)) {
      if (e.isSymbolicLink()) return { ok: false, error: 'The archive contains a link' };
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
    if (pkg.name !== 'vendo5') return { ok: false, error: 'This is not a vendo5 update' };
    runCommand(['node', '--check', path.join(staging, 'main.js')], SLOW);
    fs.rmSync(prev, { recursive: true, force: true });
    fs.renameSync(appDir, prev);
    try {
      fs.renameSync(staging, appDir);
    } catch (e) {
      fs.renameSync(prev, appDir); // put the old app back
      return { ok: false, error: 'Could not install the update' };
    }
    return { ok: true, version: pkg.version };
  } catch (e) {
    return { ok: false, error: `Update failed: ${String(e.message).split('\n')[0].slice(0, 120)}` };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// http(s) GET to a file, following up to 3 redirects, refusing more than `limit` bytes. onProgress(percent) when known.
function download(url, dest, { limit = LIMIT, onProgress = () => {}, timeoutMs = 120000, redirects = 3 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: 'Invalid URL' }); }
    if (!['http:', 'https:'].includes(u.protocol)) return resolve({ ok: false, error: 'Only http and https links work' });
    const req = (u.protocol === 'https:' ? https : http).get(u, { timeout: timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, u).href, dest, { limit, onProgress, timeoutMs, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, error: `The server answered ${res.statusCode}` }); }
      const total = Number(res.headers['content-length']) || 0;
      if (total > limit) { res.resume(); return resolve({ ok: false, error: 'The file is too large' }); }
      const out = fs.createWriteStream(dest);
      let n = 0;
      let last = -1;
      res.on('data', (c) => {
        n += c.length;
        if (n > limit) { res.destroy(); out.destroy(); fs.rmSync(dest, { force: true }); return resolve({ ok: false, error: 'The file is too large' }); }
        if (total) { const pc = Math.floor((n / total) * 10) * 10; if (pc !== last) { last = pc; onProgress(pc); } }
      });
      res.pipe(out);
      out.on('finish', () => resolve({ ok: true, bytes: n }));
      out.on('error', () => resolve({ ok: false, error: 'Could not save the download' }));
      res.on('error', () => resolve({ ok: false, error: 'The download was interrupted' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'The server did not answer in time' }); });
    req.on('error', (e) => resolve({ ok: false, error: `Could not reach the server (${e.code || 'error'})` }));
  });
}

module.exports = { applyUpdate, download, LIMIT };
