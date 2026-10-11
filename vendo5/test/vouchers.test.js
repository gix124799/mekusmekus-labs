const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVouchers, ALPHABET } = require('../lib/store/vouchers');
const { createSales } = require('../lib/store/sales');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5v-')), 'sub', 'list.json');
const FORM = { type: '0', qty: '3', length: '6', random: true, prefix: 'ab', custom: '', upload: '10M', download: '20M', duration: 3600, owner: 'Juan', price: '5', notsametype: '0' };
const seq = () => { let i = 0; return (n) => i++ % n; };

test('generate makes qty unique codes with prefix, from the unambiguous alphabet, and stores them', () => {
  const v = createVouchers({ file: file(), now: () => 123, randomInt: seq() });
  const r = v.generate(FORM);
  assert.equal(r.message, 'Done');
  assert.equal(r.newvoucher.length, 3);
  assert.equal(new Set(r.newvoucher.map((x) => x.code)).size, 3);
  for (const x of r.newvoucher) {
    assert.match(x.code, /^AB[A-Z0-9]{6}$/);
    assert.ok([...x.code.slice(2)].every((c) => ALPHABET.includes(c)));
    assert.deepEqual([x.type, x.price, x.duration, x.upload, x.genfrom, x.created], ['consumable', 5, 3600, '10M', 'Juan', 123]);
  }
  assert.equal(Object.keys(v.list()).length, 3);
});

test('real randomness: 500 codes of length 8 are all distinct and in the alphabet', () => {
  const v = createVouchers({ file: file() });
  const r = v.generate({ ...FORM, qty: 500, length: 8, prefix: '' });
  assert.equal(new Set(r.newvoucher.map((x) => x.code)).size, 500);
  assert.ok(r.newvoucher.every((x) => [...x.code].every((c) => ALPHABET.includes(c))));
});

test('pausable vouchers keep pauselimit and validity; consumable ones drop them', () => {
  const v = createVouchers({ file: file() });
  const p = v.generate({ ...FORM, qty: 1, type: '1', pauselimit: '3', validity: '24' }).newvoucher[0];
  assert.deepEqual([p.type, p.pauselimit, p.validity], ['pausable', 3, 24]);
  const c = v.generate({ ...FORM, qty: 1, pauselimit: '3', validity: '24' }).newvoucher[0];
  assert.equal(c.pauselimit, undefined);
  assert.equal(c.validity, undefined);
});

test('a custom code makes exactly one voucher and cannot repeat', () => {
  const v = createVouchers({ file: file() });
  const r = v.generate({ ...FORM, random: false, custom: 'welcome1', qty: '50' });
  assert.deepEqual(r.newvoucher.map((x) => x.code), ['WELCOME1']);
  assert.equal(v.generate({ ...FORM, random: false, custom: 'WELCOME1' }).message, 'Voucher code already exists');
});

test('every invalid form is refused with a message and writes nothing', () => {
  const f = file();
  const v = createVouchers({ file: f });
  const bad = [
    [{ qty: '0' }, 'Invalid quantity'], [{ qty: '2001' }, 'Invalid quantity'], [{ qty: 'x' }, 'Invalid quantity'], [{ qty: '1.5' }, 'Invalid quantity'],
    [{ prefix: 'a-b' }, 'Invalid prefix'], [{ prefix: '../x' }, 'Invalid prefix'],
    [{ length: '3' }, 'Invalid code length'], [{ length: '17' }, 'Invalid code length'],
    [{ random: false, custom: 'abc' }, 'Invalid custom voucher'], [{ random: false, custom: 'abc-defg' }, 'Invalid custom voucher'],
    [{ duration: 0 }, 'Invalid duration'], [{ duration: -5 }, 'Invalid duration'], [{ duration: 'x' }, 'Invalid duration'],
    [{ price: '-1' }, 'Invalid price'], [{ price: 'free' }, 'Invalid price'],
    [{ upload: '10' }, 'Invalid speed limit'], [{ download: '10X' }, 'Invalid speed limit'], [{ upload: '10m' }, 'Invalid speed limit'],
    [{ owner: 'ab' }, 'Invalid name'], [{ owner: 'a b c' }, 'Invalid name'],
  ];
  for (const [patch, msg] of bad) assert.equal(v.generate({ ...FORM, ...patch }).message, msg, JSON.stringify(patch));
  assert.equal(v.generate(null).message, 'Invalid quantity');
  assert.equal(fs.existsSync(f), false);
});

test('get/remove/update only touch real codes, never prototype names', () => {
  const v = createVouchers({ file: file() });
  const [a, b] = v.generate({ ...FORM, qty: 2 }).newvoucher;
  assert.equal(v.get('constructor'), null);
  assert.equal(v.get('__proto__'), null);
  assert.equal(v.remove(['constructor', a.code, 'nope']), 1);
  assert.equal(v.get(a.code), null);
  assert.equal(v.update(b.code, { duration: 60, upload: '1M', evil: 1 }), true);
  assert.deepEqual([v.get(b.code).duration, v.get(b.code).upload, v.get(b.code).evil], [60, '1M', undefined]);
  assert.equal(v.update('nope', { duration: 1 }), false);
});

test('a corrupt data file reads as empty instead of throwing', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{nope');
  assert.deepEqual(createVouchers({ file: f }).list(), {});
});

test('sales: add stamps the time, filter removes, cap keeps the newest', () => {
  const s = createSales({ file: file(), now: () => 7 });
  s.add({ kind: 'coin', amount: 1, mac: 'm1' });
  s.add({ kind: 'voucher', amount: 5, mac: 'm2' });
  assert.deepEqual(s.all().map((r) => [r.ts, r.kind]), [[7, 'coin'], [7, 'voucher']]);
  assert.equal(s.filter((r) => r.kind !== 'coin'), 1);
  assert.deepEqual(s.all().map((r) => r.kind), ['voucher']);
  s.clear();
  assert.deepEqual(s.all(), []);
});
