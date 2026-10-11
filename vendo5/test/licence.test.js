const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLicence, FOREVER } = require('../lib/licence');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v5lic-'));
const files = (map) => (f) => { if (f in map) return map[f]; throw new Error('ENOENT ' + f); };

test('the licence is permissive: everything on, never expires, huge limits', () => {
  const l = createLicence({ stateDir: dir(), readFile: files({ '/proc/cpuinfo': 'Serial\t\t: 02c000813c3a4a9d\n' }) }).licence();
  assert.equal(l.expiration, FOREVER);
  assert.ok(l.expiration > Date.now() + 1e12);
  assert.ok(l.hotspot >= 1000000 && l.pppoe >= 1000000);
  assert.equal(l.custom_theme, true);
  assert.equal(l.movie, true);
  assert.equal(l.checked, true);
});

test('device id: cpu serial first, then machine-id', () => {
  assert.equal(createLicence({ stateDir: dir(), readFile: files({ '/proc/cpuinfo': 'Hardware\t: x\nSerial\t\t: 02C000813C3A4A9D\n' }) }).deviceId(), '02c000813c3a4a9d');
  assert.equal(createLicence({ stateDir: dir(), readFile: files({ '/proc/cpuinfo': 'Serial\t\t: 0000000000000000\n', '/etc/machine-id': '0123456789abcdef0123456789abcdef\n' }) }).deviceId(), '0123456789abcdef');
});

test('with neither, a random id is created once and persisted', () => {
  const d = dir();
  const onlyState = (f) => { if (f.startsWith(d)) return fs.readFileSync(f, 'utf8'); throw new Error('ENOENT'); };
  const first = createLicence({ stateDir: d, readFile: onlyState, randomHex: () => 'aaaabbbbccccdddd' }).deviceId();
  assert.equal(first, 'aaaabbbbccccdddd');
  assert.equal(fs.readFileSync(path.join(d, 'device-id'), 'utf8').trim(), 'aaaabbbbccccdddd');
  assert.equal(fs.statSync(path.join(d, 'device-id')).mode & 0o777, 0o600);
  const again = createLicence({ stateDir: d, readFile: onlyState, randomHex: () => 'ffffffffffffffff' }).deviceId();
  assert.equal(again, 'aaaabbbbccccdddd', 'the persisted id wins over a new random one');
});

test('an all-zero cpu serial is not a real serial', () => {
  const d = dir();
  const id = createLicence({ stateDir: d, readFile: files({ '/proc/cpuinfo': 'Serial\t: 0000000000000000\n' }), randomHex: () => '1111222233334444' }).deviceId();
  assert.equal(id, '1111222233334444');
});
