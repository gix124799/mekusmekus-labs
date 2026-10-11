const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'vendo5-sysconfig';
const MAX_FILES = 5000;
// What a backup may contain, and where: everything vendo5 keeps in its state directory. The device id is left out on
// purpose (a restored backup must not make two devices claim the same id).
const ALLOWED = /^(account\.json|settings\.json|clients\.json|access\.json|sales\.json|notification\.json|(vouchers|credits|userlogs|mainlogs)\/[A-Za-z0-9_.:-]+)$/;

function listFiles(dir, rel = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile() && ALLOWED.test(r)) out.push(r);
  }
  return out;
}

// stateDir -> one JSON document (files as base64). Returns a Buffer.
function exportConfig(stateDir, version, now = Date.now) {
  const files = {};
  for (const r of listFiles(stateDir).slice(0, MAX_FILES)) files[r] = fs.readFileSync(path.join(stateDir, r)).toString('base64');
  return Buffer.from(JSON.stringify({ format: FORMAT, version, created: now(), files }));
}

// Restore a backup into stateDir. Validates everything before touching anything; returns {ok, count} or {ok:false, error}.
function importConfig(stateDir, buffer) {
  let doc;
  try { doc = JSON.parse(buffer.toString('utf8')); } catch { return { ok: false, error: 'Not a backup file' }; }
  if (!doc || doc.format !== FORMAT || !doc.files || typeof doc.files !== 'object' || Array.isArray(doc.files)) return { ok: false, error: 'Not a backup file' };
  const names = Object.keys(doc.files);
  if (names.length === 0 || names.length > MAX_FILES) return { ok: false, error: 'Backup is empty or too large' };
  const decoded = {};
  for (const n of names) {
    if (!ALLOWED.test(n) || typeof doc.files[n] !== 'string' || n.split('/').some((s) => s === '..' || s === '.')) return { ok: false, error: `Unexpected file in backup: ${n.slice(0, 40)}` };
    decoded[n] = Buffer.from(doc.files[n], 'base64');
  }
  // JSON documents must still parse, or a damaged backup would leave the machine unable to start its stores
  for (const [n, data] of Object.entries(decoded)) {
    if (n.endsWith('.json')) { try { JSON.parse(data.toString('utf8')); } catch { return { ok: false, error: `Damaged file in backup: ${n}` }; } }
  }
  for (const [n, data] of Object.entries(decoded)) {
    const file = path.join(stateDir, n);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data, { mode: n === 'account.json' ? 0o600 : 0o644 });
    fs.renameSync(tmp, file);
  }
  return { ok: true, count: names.length };
}

module.exports = { exportConfig, importConfig, FORMAT, ALLOWED };
