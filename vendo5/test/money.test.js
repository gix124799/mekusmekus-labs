const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore } = require('../lib/session');
const { createVouchers } = require('../lib/store/vouchers');
const { createSales } = require('../lib/store/sales');
const { createMoney, LOCK_AFTER, LOCK_MS } = require('../lib/money/redeem');

function rig({ allowThrows = false, revokeThrows = false, salesThrows = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5m-'));
  let t = 1000000;
  const sessions = createSessionStore(path.join(dir, 's.json'));
  sessions.load();
  const vouchers = createVouchers({ file: path.join(dir, 'v.json'), now: () => t });
  const sales = createSales({ file: path.join(dir, 'sales.json'), now: () => t });
  if (salesThrows) sales.add = () => { throw new Error('disk full'); };
  const calls = [];
  const firewall = { allow: (m) => { calls.push(['allow', m]); if (allowThrows) throw new Error('nft'); }, revoke: (m) => { calls.push(['revoke', m]); if (revokeThrows) throw new Error('nft'); } };
  const lines = [];
  const money = createMoney({ vouchers, sessions, firewall, sales, mainlog: { write: (c, x) => lines.push(`${c}|${x}`) }, now: () => t, save: () => calls.push(['save']) });
  const make = (patch = {}) => vouchers.generate({ type: '0', qty: 1, length: 6, random: true, prefix: '', upload: '1M', download: '1M', duration: 600, owner: 'Juan', price: 10, ...patch }).newvoucher[0];
  return { money, sessions, vouchers, sales, calls, lines, make, tick: (ms) => { t += ms; }, now: () => t };
}

test('redeeming a voucher gives time, allows the MAC, consumes the code, records the sale and the log', () => {
  const r = rig();
  const v = r.make();
  assert.deepEqual(r.money.redeemVoucher('m1', v.code.toLowerCase() + ' '), { ok: true, message: 'Success' });
  assert.equal(r.sessions.getSession('m1').expiresAt, r.now() + 600000);
  assert.equal(r.sessions.getSession('m1').code, v.code);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'allow'), [['allow', 'm1']]);
  assert.equal(r.vouchers.get(v.code), null);
  assert.deepEqual(r.sales.all().map((s) => [s.kind, s.amount, s.mac, s.code, s.owner]), [['voucher', 10, 'm1', v.code, 'Juan']]);
  assert.match(r.lines[0], /^voucher\|Voucher .* used by m1: 600s$/);
  assert.equal(r.money.redeemVoucher('m2', v.code).message, 'Invalid voucher', 'a used code is gone');
});

test('a second voucher on a live session adds time and keeps one sale each', () => {
  const r = rig();
  r.money.redeemVoucher('m1', r.make().code);
  r.money.redeemVoucher('m1', r.make().code);
  assert.equal(r.sessions.getSession('m1').expiresAt, r.now() + 1200000);
  assert.equal(r.sales.all().length, 2);
});

test('a consumable voucher cannot join a pausable session unless it allows mixing', () => {
  const r = rig();
  r.money.redeemVoucher('m1', r.make({ type: '1' }).code);
  const c = r.make({ type: '0', notsametype: '0' });
  assert.match(r.money.redeemVoucher('m1', c.code).message, /cannot be added to a pausable/);
  assert.ok(r.vouchers.get(c.code), 'refused voucher stays usable');
  const mix = r.make({ type: '0', notsametype: '1' });
  assert.equal(r.money.redeemVoucher('m1', mix.code).ok, true);
});

test('a firewall failure undoes the session and keeps the voucher', () => {
  const r = rig({ allowThrows: true });
  const v = r.make();
  const res = r.money.redeemVoucher('m1', v.code);
  assert.equal(res.ok, false);
  assert.equal(r.sessions.getSession('m1'), undefined);
  assert.ok(r.vouchers.get(v.code));
  assert.equal(r.sales.all().length, 0);
});

test('a failing sales write does not take the client\'s time away', () => {
  const r = rig({ salesThrows: true });
  const v = r.make();
  assert.equal(r.money.redeemVoucher('m1', v.code).ok, true);
  assert.ok(r.sessions.getSession('m1'));
  assert.ok(r.lines.some((l) => /Sales record failed/.test(l)));
});

test('five wrong codes lock that MAC for five minutes, other MACs are unaffected, and success resets the count', () => {
  const r = rig();
  const v = r.make();
  for (let i = 0; i < LOCK_AFTER - 1; i++) assert.equal(r.money.redeemVoucher('m1', 'WRONG' + i).message, 'Invalid voucher');
  assert.equal(r.money.redeemVoucher('m1', v.code).ok, true, 'the fifth try is a right one: not locked');
  for (let i = 0; i < LOCK_AFTER; i++) r.money.redeemVoucher('m1', 'BAD' + i);
  const good = r.make();
  assert.match(r.money.redeemVoucher('m1', good.code).message, /Too many/);
  assert.equal(r.money.redeemVoucher('m2', good.code).ok, true, 'another device is fine');
  r.tick(LOCK_MS + 1);
  assert.equal(r.money.redeemVoucher('m1', r.make().code).ok, true);
});

test('junk codes never reach the store and still count as a miss', () => {
  const r = rig();
  for (const bad of [null, undefined, '', '../../etc', 'a'.repeat(100), {}, ['A'], '__proto__', 'constructor']) assert.equal(r.money.redeemVoucher('m1', bad).ok, false, String(bad));
  assert.equal(r.money.redeemVoucher(null, 'X').message, 'Device not recognised');
});

test('pause revokes the firewall entry and freezes time; resume allows it again; failures change nothing', () => {
  const r = rig();
  r.money.redeemVoucher('m1', r.make({ type: '1', pauselimit: 2 }).code);
  r.tick(100000);
  assert.deepEqual(r.money.pause('m1'), { ok: true, message: 'Paused' });
  assert.deepEqual(r.calls.filter((c) => c[0] === 'revoke'), [['revoke', 'm1']]);
  assert.equal(r.sessions.getSession('m1').remainingMs, 500000);
  r.tick(5000000);
  assert.deepEqual(r.money.resume('m1'), { ok: true, message: 'Resumed' });
  assert.equal(r.sessions.getSession('m1').expiresAt, r.now() + 500000);
  assert.match(r.money.resume('m1').message, /Not paused/);
  assert.match(rig().money.pause('nobody').message, /No active session/);

  const bad = rig({ revokeThrows: true });
  bad.money.redeemVoucher('m1', bad.make({ type: '1' }).code);
  assert.equal(bad.money.pause('m1').ok, false);
  assert.equal(bad.sessions.getSession('m1').paused, undefined, 'a failed revoke leaves the session running');
});

test('a credit code adds pesos of time at the rate, once, records the sale and the used list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5mc-'));
  const { createCredits } = require('../lib/store/credits');
  const r = rig();
  const credits = createCredits({ file: path.join(dir, 'c.json'), now: () => r.now() });
  const money = createMoney({ vouchers: r.vouchers, credits, ratePesosPerMinute: () => 2, sessions: r.sessions, firewall: { allow: () => {}, revoke: () => {} }, sales: r.sales, mainlog: { write() {} }, now: () => r.now() });
  const [code] = Object.keys(credits.generate({ quantity: 1, amount: 10, length: 6, name: 'Pedro' }).codes);
  assert.deepEqual(money.redeemVoucher('m1', code), { ok: true, message: 'Success' });
  assert.equal(r.sessions.getSession('m1').expiresAt, r.now() + 5 * 60000, '10 pesos at 2 pesos a minute');
  assert.equal(r.sessions.getSession('m1').creditPesos, 10);
  assert.deepEqual(r.sales.all().map((s) => [s.kind, s.amount, s.code, s.owner]), [['credit', 10, code, 'Pedro']]);
  assert.equal(JSON.parse(credits.usedText()).mac, 'm1');
  assert.equal(money.redeemVoucher('m2', code).message, 'Invalid voucher');
});
