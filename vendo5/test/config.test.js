const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, getConfig } = require('../lib/config');

const GOOD = {
  'network.json': { lan_interface: 'br-lan' },
  'vendo.json': { coin_pin: 17, pulse_value_pesos: 1, pesos_per_minute: 1 },
  'licensing.json': { mode: 'offline' },
};
function mk(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v5cfg-'));
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(d, n), typeof v === 'string' ? v : JSON.stringify(v));
  return d;
}

test('getConfig before loadConfig throws', () => {
  assert.throws(() => getConfig(), /not loaded/);
});

test('happy path merges by filename stem and caches', () => {
  const cfg = loadConfig(mk(GOOD), '/nonexistent');
  assert.equal(cfg.vendo.coin_pin, 17);
  assert.equal(cfg.network.lan_interface, 'br-lan');
  assert.strictEqual(getConfig(), cfg);
});

test('missing required key names file and key', () => {
  const d = mk({ ...GOOD, 'vendo.json': {} });
  assert.throws(() => loadConfig(d, '/nonexistent'), /vendo\.json.*coin_pin/);
});

test('missing required file is an error', () => {
  const { 'licensing.json': _, ...rest } = GOOD;
  assert.throws(() => loadConfig(mk(rest), '/nonexistent'), /licensing\.json/);
});

test('invalid JSON names the file', () => {
  const d = mk({ ...GOOD, 'network.json': '{oops' });
  assert.throws(() => loadConfig(d, '/nonexistent'), /network\.json/);
});

test('non-json files and subdirs are ignored', () => {
  const d = mk(GOOD);
  fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(d, 'sub.json'));
  assert.doesNotThrow(() => loadConfig(d, '/nonexistent'));
});

test('missing dir: defaults are copied then loaded', () => {
  const defaults = mk(GOOD);
  const target = path.join(os.tmpdir(), 'v5cfg-new-' + process.pid);
  fs.rmSync(target, { recursive: true, force: true });
  const cfg = loadConfig(target, defaults);
  assert.equal(cfg.vendo.coin_pin, 17);
  assert.ok(fs.existsSync(path.join(target, 'vendo.json')));
});

test('empty dir: defaults are copied', () => {
  const defaults = mk(GOOD);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'v5cfg-empty-'));
  assert.equal(loadConfig(target, defaults).licensing.mode, 'offline');
});

test('first boot with no defaults dir is a clear error', () => {
  const target = path.join(os.tmpdir(), 'v5cfg-nodef-' + process.pid);
  fs.rmSync(target, { recursive: true, force: true });
  assert.throws(() => loadConfig(target, '/nonexistent-defaults'), /defaults/);
});
