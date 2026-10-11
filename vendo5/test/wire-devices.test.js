const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDeviceHandlers } = require('../lib/wire/devices');
const { createClients } = require('../lib/store/clients');
const { createAccess } = require('../lib/store/access');
const { createClientLog } = require('../lib/store/clientlog');
const { createSessionStore } = require('../lib/session');
const { createVouchers } = require('../lib/store/vouchers');
const { createSales } = require('../lib/store/sales');
const { createMoney } = require('../lib/money/redeem');

const M1 = 'aa:bb:cc:dd:ee:01';
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5dv-'));
  let t = 1000000;
  const clients = createClients({ file: path.join(dir, 'c.json') });
  const access = createAccess({ file: path.join(dir, 'a.json') });
  const clientLog = createClientLog({ dir: path.join(dir, 'ul'), now: () => new Date(2026, 9, 11, 14, 5, 9) });
  const sessions = createSessionStore(path.join(dir, 's.json'));
  sessions.load();
  const fw = [];
  const firewall = { allow: (m) => fw.push(['allow', m]), revoke: (m) => fw.push(['revoke', m]) };
  const lines = [];
  const mainlog = { write: (c, x) => lines.push(x) };
  const money = createMoney({ vouchers: createVouchers({ file: path.join(dir, 'v.json') }), access, clientLog, sessions, firewall, sales: createSales({ file: path.join(dir, 'sa.json') }), mainlog, now: () => t });
  const h = createDeviceHandlers({ clients, access, clientLog, sessions, money, firewall, mainlog });
  return { h, call: (id, p) => h[id].handler(p, {}), clients, access, clientLog, sessions, fw, lines, money };
}

test('every device event is guarded', () => { for (const [id, d] of Object.entries(rig().h)) assert.equal(d.guard, true, id); });

test('client table: keyed by MAC without colons, includes devices with a session, names and totals come from the store', () => {
  const r = rig();
  r.sessions.addTime(M1, 60000, {}, Date.now());
  r.clients.setName(M1, 'Maria');
  r.clients.addTotal(M1, 7);
  const out = r.call('@nav-77833');
  assert.equal(out.idbase, false);
  assert.deepEqual(Object.keys(out.client.clientInfo), ['aabbccddee01']);
  assert.deepEqual(out.client.clientInfo.aabbccddee01, { mac: M1, name: 'Maria', credit: 0, point: 0, total: 7 });
  assert.deepEqual(out.client.infos, {});
});

test('row actions: name, credit, points, clear total, remove (also ends the session and drops the log)', () => {
  const r = rig();
  assert.equal(r.call('@nav-33244', { action: 'set-name', mac: M1, name: 'Maria' }), 'Success');
  assert.equal(r.call('@nav-33244', { action: 'set-credit', mac: M1, newCredit: 12.5 }), 'Success');
  assert.equal(r.call('@nav-33244', { action: 'set-points', mac: M1, points: 3 }), 'Success');
  assert.deepEqual([r.clients.all()[M1].name, r.clients.all()[M1].credit, r.clients.all()[M1].point], ['Maria', 12.5, 3]);
  r.clients.addTotal(M1, 9);
  assert.equal(r.call('@nav-33244', { action: 'total-credit-clear', mac: M1 }), 'Success');
  assert.equal(r.clients.all()[M1].total, 0);
  r.sessions.addTime(M1, 60000, {}, Date.now());
  r.clientLog.write(M1, 'x');
  assert.equal(r.call('@nav-33244', { action: 'client-remove', maclist: { mac: M1 } }), 'Success');
  assert.equal(r.sessions.getSession(M1), undefined);
  assert.equal(r.clients.all()[M1], undefined);
  assert.equal(r.clientLog.read(M1).data, '');
});

test('junk to the row actions answers Error and changes nothing', () => {
  const r = rig();
  for (const bad of [null, {}, { action: 'set-credit', mac: 'zz', newCredit: 1 }, { action: 'set-credit', mac: M1, newCredit: -1 }, { action: 'set-credit', mac: M1, newCredit: 'x' }, { action: 'set-name', mac: M1, name: 'x'.repeat(41) }, { action: 'client-remove', maclist: {} }, { action: 'nuke', mac: M1 }, 'x']) assert.equal(r.call('@nav-33244', bad), 'Error', JSON.stringify(bad));
  assert.deepEqual(r.clients.all(), {});
});

test('per-device log: lines in the format the page parses, read by key, delete', () => {
  const r = rig();
  r.clientLog.write(M1, 'Voucher AB used\nsecond line');
  assert.equal(r.call('@nav-300214', 'aabbccddee01').data, '11/10/2026 02:05:09 pm Voucher AB used second line\n');
  assert.equal(r.call('@nav-300214', '../etc/passwd').data, '');
  assert.deepEqual(r.call('@nav-30210', 'aabbccddee01'), {});
  assert.equal(r.call('@nav-300214', 'aabbccddee01').data, '');
  assert.equal(r.call('@nav-30210', '../x').err, 'invalid id');
});

test('free session: valid form gives time and a firewall allow; bad MAC/duration/speed is refused', () => {
  const r = rig();
  const form = { type: '1', custom: 'x', upload: '1M', download: '2M', duration: 3600, owner: 'Juan', mac: M1.toUpperCase(), pauselimit: 2 };
  assert.equal(r.call('@nav-96549', form), true);
  assert.deepEqual(r.fw, [['allow', M1]]);
  const s = r.sessions.getSession(M1);
  assert.deepEqual([s.type, s.upload, s.download, s.pauselimit], ['pausable', '1M', '2M', 2]);
  for (const bad of [null, {}, { ...form, mac: 'nope' }, { ...form, duration: 0 }, { ...form, duration: '5' }, { ...form, upload: '1' }]) assert.equal(r.call('@nav-96549', bad), false, JSON.stringify(bad));
});

test('block list: add ends the session and refuses redemption; whitelist allows the device; both can be listed and removed', () => {
  const r = rig();
  r.sessions.addTime(M1, 60000, {}, Date.now());
  assert.deepEqual(r.call('@nav-33254E', { action: 'add', blacklist: true, mac: 'AA-BB-CC-DD-EE-01', name: 'Bad' }), { fl: null, fwl: 0 });
  assert.equal(r.sessions.getSession(M1), undefined);
  assert.equal(r.money.redeemVoucher(M1, 'WHATEVER').message, 'This device is blocked');
  assert.deepEqual(r.call('@nav-33254E', { action: 'get', blacklist: true }).blacklist, { 'AA:BB:CC:DD:EE:01': 'Bad' });
  r.call('@nav-33254E', { action: 'add', whitelist: true, mac: 'AA:BB:CC:DD:EE:01', name: 'Owner' });
  assert.deepEqual(r.call('@nav-33254E', { action: 'get' }), { blacklist: {}, whitelist: { 'AA:BB:CC:DD:EE:01': 'Owner' } }, 'moving to the whitelist unblocks it');
  assert.ok(r.fw.some((c) => c[0] === 'allow'));
  assert.equal(r.call('@nav-33254E', { action: 'remove', whitelist: true, mac: 'AA:BB:CC:DD:EE:01' }), 'Success');
  assert.equal(r.call('@nav-33254E', { action: 'remove', whitelist: true, mac: 'AA:BB:CC:DD:EE:01' }), 'Error');
  for (const bad of [null, {}, { action: 'add', blacklist: true, mac: 'nope', name: 'x' }, { action: 'add', blacklist: true, mac: M1 }, { action: 'add', mac: M1, name: 'x' }]) assert.equal(r.call('@nav-33254E', bad), 'Error', JSON.stringify(bad));
});

test('the unique-id events answer "not in use"', () => {
  const r = rig();
  assert.deepEqual(r.call('@nav-113354'), {});
  assert.deepEqual(r.call('@nav-113311', { action: 'remove', mac: M1 }), { success: false });
});
