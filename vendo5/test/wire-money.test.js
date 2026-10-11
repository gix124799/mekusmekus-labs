const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMoneyHandlers } = require('../lib/wire/money');
const { createVouchers } = require('../lib/store/vouchers');
const { createTickets } = require('../lib/store/tickets');
const { createSessionStore } = require('../lib/session');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5wm-'));
  let t = 1000000;
  const sessions = createSessionStore(path.join(dir, 's.json'));
  sessions.load();
  const vouchers = createVouchers({ file: path.join(dir, 'v.json'), now: () => t });
  const tickets = createTickets({ file: path.join(dir, 't.json'), now: () => t++ });
  const lines = [];
  const saved = [];
  const h = createMoneyHandlers({ vouchers, tickets, sessions, mainlog: { write: (c, x) => lines.push(`${c}|${x}`) }, now: () => t, save: () => saved.push(1) });
  const call = (id, p) => h[id].handler(p, {});
  return { h, call, sessions, vouchers, tickets, lines, saved };
}
const FORM = { type: '0', qty: 2, length: 6, random: true, prefix: 'x', upload: '1M', download: '1M', duration: 600, owner: 'Juan', price: 5 };

test('every voucher event is guarded', () => {
  for (const [id, d] of Object.entries(rig().h)) assert.equal(d.guard, true, id);
});

test('generate, list, remove', () => {
  const r = rig();
  const g = r.call('@nav-96547', FORM);
  assert.equal(g.message, 'Done');
  assert.equal(Object.keys(r.call('@nav-55647')).length, 2);
  assert.match(r.lines[0], /^voucher\|Admin generated 2 voucher/);
  const [a, b] = g.newvoucher.map((v) => v.code);
  r.call('@nav-52212', { [a]: true, constructor: true });
  assert.deepEqual(Object.keys(r.call('@nav-55647')), [b]);
  r.call('@nav-52212', [b]);
  assert.deepEqual(r.call('@nav-55647'), {});
  assert.equal(r.call('@nav-96547', { ...FORM, qty: 0 }).message, 'Invalid quantity');
  assert.equal(r.call('@nav-96547', null).message, 'Invalid quantity');
});

test('active vouchers list the sessions that came from a code, in the row shape the page reads', () => {
  const r = rig();
  r.sessions.addTime('m1', 600000, { code: 'AAA111', type: 'consumable', upload: '1M', download: '2M' }, 1000000);
  r.sessions.addTime('m2', 600000, { code: 'BBB222', type: 'pausable', pauselimit: 2, validityHours: 1 }, 1000000);
  r.sessions.addCredit('m3', 1, 1, 1000000); // a coin session has no voucher
  const list = r.call('@nav-12215');
  assert.deepEqual(list.map((e) => e.code), ['AAA111', 'BBB222']);
  assert.equal(list[0].expiration, 1600000);
  assert.equal(list[0].duration, undefined);
  assert.deepEqual([list[0].uploadLimit, list[0].downloadLimit], ['1M', '2M']);
  assert.equal(list[1].duration, 600);
  assert.equal(list[1].pauselimit, 2);
  assert.ok(list[1].validity > 0);
});

test('edit changes limits and pause count of a running voucher; junk is ignored', () => {
  const r = rig();
  r.sessions.addTime('m2', 600000, { code: 'BBB222', type: 'pausable', pauselimit: 2 }, 1000000);
  r.call('@nav-43456', { code: 'BBB222', uploadLimit: '5M', downloadLimit: 'fast', pauselimit: 9 });
  const s = r.sessions.getSession('m2');
  assert.deepEqual([s.upload, s.download, s.pauselimit], ['5M', undefined, 9]);
  r.call('@nav-43456', { mac: 'm2', uploadLimit: '10M' });
  assert.equal(s.upload, '10M');
  for (const bad of [null, 'x', {}, { code: 'NOPE' }, { pauselimit: -1 }]) assert.deepEqual(r.call('@nav-43456', bad), {});
  assert.equal(s.pauselimit, 9);
});

test('extend adds time to the selected active vouchers only', () => {
  const r = rig();
  r.sessions.addTime('m1', 600000, { code: 'AAA111' }, 1000000);
  r.sessions.addTime('m2', 600000, { code: 'BBB222' }, 1000000);
  r.call('@nav-43000', { list: { AAA111: true, ZZZ999: true }, duration: 3600 });
  assert.equal(r.sessions.getSession('m1').expiresAt, 1000000 + 600000 + 3600000);
  assert.equal(r.sessions.getSession('m2').expiresAt, 1600000);
  r.call('@nav-43000', { list: { BBB222: true }, duration: 'x' });
  assert.equal(r.sessions.getSession('m2').expiresAt, 1600000);
});

test('ticket templates: save, list, read, delete', () => {
  const r = rig();
  const name = r.call('@nav-29903', { name: 'voucher', title: 'Promo', price: 5, data: [['A', 'B']] });
  assert.match(name, /^voucher-\d+$/);
  assert.deepEqual(Object.keys(r.call('@nav-55685')), [name]);
  assert.deepEqual(JSON.parse(r.call('@nav-55699', name)).data, [['A', 'B']]);
  assert.equal(r.call('@nav-55699', '../x'), '');
  assert.equal(r.call('@nav-29903', { data: [] }), '');
  assert.equal(r.call('@nav-23466', '../x'), 'Error');
  assert.equal(r.call('@nav-23466', name), 'Success');
  assert.equal(r.call('@nav-23466', name), 'Error');
});
