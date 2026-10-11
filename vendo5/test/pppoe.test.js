const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPppoe } = require('../lib/store/pppoe');
const { createPppoeSystem, toBits } = require('../lib/system/pppoe');
const { createPppoeHandlers } = require('../lib/wire/pppoe');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5pp-'));
  let t = Date.parse('2026-10-11T00:00:00');
  const store = createPppoe({ file: path.join(dir, 'p.json'), now: () => t });
  const calls = [];
  const system = createPppoeSystem({ store, secretsFile: path.join(dir, 'ppp', 'chap-secrets'), limitsDir: path.join(dir, 'limits'), sessionsDir: path.join(dir, 'sessions'), runCommand: (a) => calls.push(a), now: () => t });
  const lines = [];
  const h = createPppoeHandlers({ store, system, mainlog: { write: (c, x) => lines.push(x) }, now: () => t });
  return { h, store, system, dir, calls, lines, tick: (ms) => { t += ms; }, call: (id, p) => h[id].handler(p, {}), now: () => t };
}
const FORM = { username: 'maria', password: 'pass1234', upload: '5M', download: '10M', date: '2026-11-01', time: '12:00:00', amount: '300' };

test('every PPPoE event is guarded', () => { for (const [id, d] of Object.entries(rig().h)) assert.equal(d.guard, true, id); });

test('create, list, edit, remove; the list carries "now" for the page\'s Active/Expired colouring', () => {
  const r = rig();
  assert.equal(r.call('@nav-32344', FORM), 'Success');
  const l = r.call('@nav-23442');
  assert.equal(l.now, r.now());
  assert.deepEqual([l.info.maria.upload, l.info.maria.amount, l.info.maria.total_payment, l.info.maria.expiration], ['5M', 300, 300, Date.parse('2026-11-01 12:00:00')]);
  assert.equal(r.call('@nav-32344', FORM), 'Username already exists');
  assert.equal(r.call('@nav-89112', { ...l.info.maria, upload: '8M', expiration: Date.parse('2026-12-01') }), 'Success');
  assert.equal(r.call('@nav-23442').info.maria.upload, '8M');
  assert.equal(r.call('@nav-89112', { ...l.info.maria, username: 'ghost1' }), 'Username not found!');
  assert.equal(r.call('@nav-65698', { maria: 1, nobody: 1 }), 0, '0 is success, as the page tests');
  assert.equal(r.call('@nav-65698', { nobody: 1 }), 1);
  assert.deepEqual(r.call('@nav-23442').info, {});
});

test('create refuses bad forms with a message and stores nothing', () => {
  const r = rig();
  for (const [patch, re] of [[{ username: 'ab' }, /Username/], [{ username: 'a b c d' }, /Username/], [{ password: 'abc' }, /Password/], [{ password: 'a"b"c"d' }, /Password/], [{ upload: '5' }, /speed/], [{ download: 'fast' }, /speed/], [{ date: 'x' }, /expiration/i], [{ date: '2020-01-01' }, /Expired/], [{ amount: '-1' }, /amount/]]) assert.match(r.call('@nav-32344', { ...FORM, ...patch }), re, JSON.stringify(patch));
  assert.equal(r.call('@nav-32344', null), 'Username must be 4-10 letters or numbers');
  assert.deepEqual(r.call('@nav-23442').info, {});
});

test('secrets file: only live accounts, atomic, mode 0600, passwords escaped; limits files hold bits per second', () => {
  const r = rig();
  r.call('@nav-32344', FORM);
  r.call('@nav-32344', { ...FORM, username: 'pedro', password: 'a\\b"c' .replace(/[\\"]/g, '_'), date: '2026-10-12' });
  const file = path.join(r.dir, 'ppp', 'chap-secrets');
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').slice(1), ['"maria" * "pass1234" *', '"pedro" * "a_b_c" *']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(r.dir, 'limits', 'maria'), 'utf8'), '5000000 10000000\n');
  r.tick(2 * 86400000);
  r.system.sync();
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').slice(1), ['"maria" * "pass1234" *'], 'an expired account loses its secret');
  r.call('@nav-65698', { maria: 1 });
  assert.equal(fs.existsSync(path.join(r.dir, 'limits', 'maria')), false, 'and a removed one its limits');
  assert.equal(toBits('3G'), 3e9);
  assert.equal(toBits('x'), 0);
});

test('online sessions come from the ip-up records; disconnect hangs up and forgets them; sweep drops expired users', () => {
  const r = rig();
  r.call('@nav-32344', FORM);
  fs.mkdirSync(path.join(r.dir, 'sessions'), { recursive: true });
  const rec = (n, u) => fs.writeFileSync(path.join(r.dir, 'sessions', `${n}.json`), JSON.stringify({ username: u, remoteIP: '10.9.0.2', mac: 'AA:BB:CC:00:00:01', since: r.now() - 5000 }));
  rec('ppp0', 'maria');
  fs.writeFileSync(path.join(r.dir, 'sessions', 'ppp1.json'), '{half');
  fs.writeFileSync(path.join(r.dir, 'sessions', 'evil.json'), JSON.stringify({ username: 'x' }));
  assert.deepEqual(r.system.active().map((a) => [a.username, a.ifname, a.mac]), [['maria', 'ppp0', 'aa:bb:cc:00:00:01']]);
  assert.equal(r.call('@nav-78663', 'maria'), true);
  assert.equal(r.call('@nav-78663', 'maria'), false, 'nothing left to hang up');
  assert.deepEqual(r.calls.at(-1).slice(0, 2), ['pkill', '-HUP']);
  rec('ppp0', 'maria');
  r.tick(40 * 86400000);
  r.system.sweep();
  assert.equal(r.system.active().length, 0, 'an expired user is hung up by the sweep');
  assert.equal(r.call('@nav-00782399').stdout, '');
});

test('billing: add client, rate, payments, set payments, link a PPPoE user, remove; bad input answers {err}', () => {
  const r = rig();
  const add = { action: 'ADD', id: 'c1', name: 'Juan', username: 'maria', password: 'pass1234', amount: '500', location: '14.5,121', apikey: '', startdate: Date.parse('2026-09-01') };
  assert.deepEqual(r.call('@nav-36582399', add), {});
  assert.equal(r.call('@nav-36582399', add).err, 'Duplicate id');
  for (const bad of [{ ...add, id: 'c2', name: '' }, { ...add, id: '../x' }, { ...add, id: 'c3', amount: 'x' }, { ...add, id: 'c4', startdate: 'x' }]) assert.ok(r.call('@nav-36582399', bad).err, JSON.stringify(bad));
  assert.deepEqual(r.call('@nav-36582399', { action: 'ADDPAYMENT', id: 'c1', payment: { targetmonth: 'Sep 2026', amount: 500 } }), {});
  assert.equal(r.call('@nav-36582399', { action: 'ADDPAYMENT', id: 'c1', payment: { targetmonth: 'Sep 2026', amount: 0 } }).err, 'Invalid payment');
  assert.equal(r.call('@nav-36582399', { action: 'ADDPAYMENT', id: 'nope', payment: { targetmonth: 'x', amount: 1 } }).err, 'Client not found');
  assert.equal(r.call('@nav-36582399', { action: 'GET' }).c1.paid[0].amount, 500);
  r.call('@nav-36582399', { action: 'SETRATEAMOUNT', id: 'c1', amount: 600, date: '2026-10-01' });
  assert.deepEqual(r.call('@nav-36582399', { action: 'GET' }).c1.amount, [{ date: Date.parse('2026-09-01'), amount: 500 }, { date: '2026-10-01', amount: 600 }]);
  r.call('@nav-36582399', { action: 'SETRATEAMOUNT', id: 'c1', amount: 700 });
  assert.equal(r.call('@nav-36582399', { action: 'GET' }).c1.amount, 700, 'a plain set replaces the rate (and its history) with one flat amount');
  assert.equal(r.call('@nav-36582399', { action: 'SETRATEAMOUNT', id: 'c1', amount: -1 }).err, 'Invalid amount');
  assert.deepEqual(r.call('@nav-36582399', { action: 'SETPAYMENT', id: 'c1', paid: [{ targetmonth: 'Oct 2026', amount: 100 }] }), {});
  assert.equal(r.call('@nav-36582399', { action: 'GET' }).c1.paid.length, 1);
  assert.equal(r.call('@nav-36582399', { action: 'SETPAYMENT', id: 'c1', paid: 'x' }).err, 'Invalid payment list');
  r.call('@nav-36582399', { action: 'SETPPPoE', id: 'c1', username: 'pedro' });
  assert.equal(r.call('@nav-36582399', { action: 'GET' }).c1.username, 'pedro');
  assert.deepEqual(r.call('@nav-36582399', { action: 'REMOVE', id: 'c1' }), {});
  assert.equal(r.call('@nav-36582399', { action: 'REMOVE', id: 'c1' }).err, 'Client not found');
  assert.equal(r.call('@nav-36582399', { action: 'nuke' }).err, 'Error');
});
