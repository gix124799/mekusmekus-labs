const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsHandlers } = require('../lib/wire/settings');
const { createSettings } = require('../lib/store/settings');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5set-'));
  const file = path.join(dir, 'settings.json');
  const settings = createSettings({ file, deviceName: 'ETHYLNET', coinPin: 17 });
  const lines = [];
  let restarts = 0;
  const h = createSettingsHandlers({ settings, deviceName: 'ETHYLNET', mainlog: { write: (c, x) => lines.push(x) }, restart: () => { restarts++; } });
  return { h, settings, lines, file, restarts: () => restarts, call: (id, p) => h[id].handler(p, {}) };
}
const ROW = (coin, minute, config = { type: 'consumable', upload: '2M', download: '2M' }) => ({ action: 'add-config', id: 'main', coin, minute, config });

test('every settings event is guarded', () => { for (const [id, d] of Object.entries(rig().h)) assert.equal(d.guard, true, id); });

test('vendo info: factory state has this machine as "main" with the configured coin pin', () => {
  const r = rig();
  const a = r.call('@nav-22114');
  assert.equal(a.hostname, 'ETHYLNET');
  assert.equal(a.vendoInfo.sub.main.coinpin, 17);
  assert.equal(a.vendoInfo.sub.main.id, 'main');
  assert.deepEqual(a.vendoInfo.sub.main.config, { set: { type: 0 }, rate: [] });
  assert.equal(a.vendoInfo.insertBanDuration, 3);
  assert.deepEqual(r.call('@nav-22125').request, []);
  assert.ok(r.call('@nav-22125').vendoOnline.main, 'the page reads vendoOnline.main for the machine\'s own row');
});

test('rate table: add, reject duplicates and junk, edit (incl. changing the coin), toggle show, remove', () => {
  const r = rig();
  assert.equal(r.call('@nav-22126', ROW(5, 1800)).config.rate.length, 1);
  assert.equal(r.call('@nav-22126', ROW(5, 600)).err, 'Rate Already Exist');
  assert.ok(r.call('@nav-22126', ROW(0, 600)).err);
  assert.ok(r.call('@nav-22126', ROW(10, 0)).err);
  assert.ok(r.call('@nav-22126', ROW(10, 60, { type: 'consumable', upload: 'x', download: '1M' })).err);
  r.call('@nav-22126', ROW(1, 300));
  const e = r.call('@nav-22126', { action: 'edit-config', id: 'main', oldcoin: 5, newcoin: 10, minute: 3600, config: { type: 'pausable', upload: '1M', download: '1M', pauselimit: 2 } });
  assert.deepEqual(e.config.rate.map((x) => [x.coin, x.minute]).sort((a, b) => a[0] - b[0]), [[1, 300], [10, 3600]]);
  assert.equal(e.config.rate.find((x) => x.coin === 10).vendoset.pauselimit, 2);
  assert.equal(r.call('@nav-22126', { action: 'edit-config', oldcoin: 99, newcoin: 7, minute: 60, config: {} }).err, 'Rate not found');
  assert.equal(r.call('@nav-22126', { action: 'edit-config', oldcoin: 10, newcoin: 1, minute: 60, config: {} }).err, 'Rate Already Exist');
  assert.equal(r.call('@nav-22126', { action: 'setShow', coin: 1, show: false }).config.rate.find((x) => x.coin === 1).show, false);
  assert.deepEqual(r.call('@nav-22126', { action: 'remove-config', coin: 1 }).config.rate.map((x) => x.coin), [10]);
  assert.equal(r.call('@nav-22126', { action: 'setType', type: 1 }).config.set.type, 1);
  assert.deepEqual(r.call('@nav-22126', { action: 'setType', type: 7 }), {});
  assert.ok(r.lines.some((l) => /added the rate 5 peso/.test(l)));
});

test('vendo options: key, name, description, countdown, corrector validate their ranges (and answer the page\'s falsy-is-ok convention)', () => {
  const r = rig();
  assert.deepEqual(r.call('@nav-22126', { action: 'edit-key', key: 'ABCDEFGHIJKLMN' }), {});
  assert.ok(r.call('@nav-22126', { action: 'edit-key', key: 'short' }).err);
  assert.ok(r.call('@nav-22126', { action: 'edit-name-sub-vendo', name: 'abc' }).err);
  assert.deepEqual(r.call('@nav-22126', { action: 'edit-name-sub-vendo', name: 'Main Vendo' }), {});
  assert.equal(r.call('@nav-22126', { action: 'set-coundown', countdownMax: 30 }), '');
  for (const bad of [9, 121, 'x', 30.5]) assert.equal(r.call('@nav-22126', { action: 'set-coundown', countdownMax: bad }), 'Error', String(bad));
  assert.equal(r.call('@nav-22126', { action: 'set-corrector', coinsBlockerDelay: 800, insertCoinType: 1, coinCorrector: [{ a: 1 }] }), '');
  for (const bad of [{ coinsBlockerDelay: 100, insertCoinType: 1, coinCorrector: [] }, { coinsBlockerDelay: 800, insertCoinType: 5, coinCorrector: [] }, { coinsBlockerDelay: 800, insertCoinType: 1, coinCorrector: 'x' }]) assert.equal(r.call('@nav-22126', { action: 'set-corrector', ...bad }), 'Error');
  const m = r.call('@nav-22114').vendoInfo.sub.main;
  assert.deepEqual([m.name, m.countdownMax, m.coinsBlockerDelay, m.insertCoinType], ['Main Vendo', 30, 800, 1]);
  assert.deepEqual(r.call('@nav-22126', null), { err: 'Error' });
  assert.deepEqual(r.call('@nav-22126', { action: 'nuke' }), { err: 'Error' });
});

test('pin setup validates all pins, saves them, and asks for a restart', () => {
  const r = rig();
  assert.deepEqual(r.call('@nav-22115', { id: 'main', insertled: 3, powerled: 4, relay: 5, incoin: 6, inbill: '', billmulti: 2 }), {});
  assert.equal(r.restarts(), 1);
  assert.deepEqual(r.call('@nav-225585', { id: 'main' }), { id: 'main', pins: { insertled: 3, powerled: 4, relay: 5, incoin: 6, inbill: '', billmulti: 2 } });
  assert.equal(r.call('@nav-22114').vendoInfo.sub.main.coinpin, 6);
  for (const bad of [{ insertled: 300 }, { insertled: -1 }, { insertled: 'x' }, { billmulti: 0 }, { inbill: 999 }]) { r.call('@nav-22115', { id: 'main', insertled: 3, powerled: 4, relay: 5, incoin: 6, ...bad }); }
  assert.equal(r.restarts(), 1, 'a bad form never restarts the machine');
});

test('small field edits (36625) answer true/false and persist', () => {
  const r = rig();
  assert.equal(r.call('@nav-36625', { setBanduration: true, value: 10 }), true);
  assert.equal(r.call('@nav-36625', { setBancount: true, value: 5 }), true);
  assert.equal(r.call('@nav-36625', { setEdge: true, edge: 'falling' }), true);
  assert.equal(r.call('@nav-36625', { setInsertbtn: true, value: 'false' }), true);
  assert.equal(r.call('@nav-36625', { setVendoName: true, name: 'Shop' }), true);
  assert.equal(r.call('@nav-36625', { setHostname: true, hostname: 'my-vendo' }), true);
  const a = r.call('@nav-22114');
  assert.deepEqual([a.vendoInfo.insertBanDuration, a.vendoInfo.insertBancount, a.vendoInfo.sub.main.edge, a.vendoInfo.sub.main.insertbtn, a.vendoInfo.sub.main.name, a.hostname], [10, 5, 'falling', false, 'Shop', 'my-vendo']);
  for (const bad of [{ setBanduration: true, value: 0 }, { setEdge: true, edge: 'sideways' }, { setHostname: true, hostname: 'bad host!' }, { setCoinPin: true, pin: 999 }, { setrelayactive: true, active: 2 }, {}, null]) assert.equal(r.call('@nav-36625', bad), false, JSON.stringify(bad));
});

test('trial, redirect, footer: round-trip and refuse unsafe input', () => {
  const r = rig();
  assert.equal(r.call('@nav-36541223', { action: 'SET', config: { default: { enable: true, minutes: 5 } } }), '');
  assert.deepEqual(r.call('@nav-36541223', { action: 'GET' }), { default: { enable: true, minutes: 5 } });
  assert.equal(r.call('@nav-36541223', { action: 'SET', config: [] }), 'Error');
  r.call('@nav-2311454', { action: 'SET', url: 'http://10.0.0.1/welcome' });
  assert.deepEqual(JSON.parse(r.call('@nav-2311454', { action: 'GET' })), { url: 'http://10.0.0.1/welcome' });
  r.call('@nav-2311454', { action: 'SET', url: 'javascript:alert(1)' });
  assert.equal(JSON.parse(r.call('@nav-2311454', { action: 'GET' })).url, 'http://10.0.0.1/welcome', 'a non-http redirect is refused');
  assert.equal(r.call('@nav-453648', { action: 'SET', footer: '<b>Thanks</b> for visiting' }), '');
  assert.equal(r.call('@nav-453648', { action: 'GET' }), '<b>Thanks</b> for visiting');
  for (const bad of ['<script>x</script>', '<img src=x>', '<a onclick=x>', '<a href="javascript:1">', 'x'.repeat(501)]) assert.equal(r.call('@nav-453648', { action: 'SET', footer: bad }), 'Error', bad.slice(0, 20));
});

test('pausable switches, id key, idbase stay simple and safe', () => {
  const r = rig();
  r.call('@nav-33254589', { action: 'SET', value: { autopause: true, autolimit: 1 } });
  assert.deepEqual(r.call('@nav-33254589', { action: 'GET' }), { autopause: true, autolimit: true });
  assert.equal(r.call('@nav-55332145', { action: 'SET', value: 'abcd1234' }), 'Success');
  assert.equal(r.call('@nav-55332145', { action: 'GET' }), 'abcd1234');
  assert.equal(r.call('@nav-55332145', { action: 'SET', value: 'x'.repeat(9) }), 'Success');
  assert.equal(r.call('@nav-55332145', { action: 'GET' }), 'abcd1234', 'an over-long key is not stored');
  assert.equal(r.call('@nav-00332145', { action: 'GET' }), false);
  assert.equal(r.call('@nav-00332145', { action: 'SET', value: true }), 'Error');
});

test('game ports: save, list, remove; invalid ports refused', () => {
  const r = rig();
  r.call('@nav-003321', { name: 'Mobile Legends!', ports: [[30000, 30100], [5000]] });
  assert.deepEqual(r.call('@nav-002331'), [{ filename: 'MobileLegends', name: 'MobileLegends', ports: [[30000, 30100], [5000]] }]);
  for (const bad of [{ name: '', ports: [[1]] }, { name: 'x', ports: [] }, { name: 'x', ports: [[0]] }, { name: 'x', ports: [[70000]] }, { name: 'x', ports: [[1, 2, 3]] }, { name: 'x', ports: 'a' }, null]) r.call('@nav-003321', bad);
  assert.equal(r.call('@nav-002331').length, 1);
  r.call('@nav-003146', 'constructor');
  r.call('@nav-003146', 'MobileLegends');
  assert.deepEqual(r.call('@nav-002331'), []);
});

test('point system: spin wheel lists, token, redeem items, and per-coin point rules', () => {
  const r = rig();
  const wheel = (action, key, extra = {}) => r.call('@nav-0092734', { action, path: 'spinwheel', key, ...extra });
  assert.equal(wheel('Add SpinWheel', 'display', { config: { id: 'a1', name: 'Win', color: '#fff', value: 'p1', font: 'x' } }), '');
  wheel('Add SpinWheel', 'display', { config: { id: 'a2', name: 'Lose', color: '#000', value: 'p2', font: 'x' } });
  wheel('Set SpinWheel Order', 'display', { value: [{ id: 'a2' }, { id: 'a1' }, { id: 'ghost' }] });
  assert.deepEqual(r.call('@nav-0092734', { action: 'GET' }).spinwheel.display.map((x) => x.id), ['a2', 'a1']);
  wheel('Remove SpinWheel', 'display', { id: 'a2' });
  assert.deepEqual(r.call('@nav-0092734', { action: 'GET' }).spinwheel.display.map((x) => x.id), ['a1']);
  assert.equal(wheel('Add SpinWheel', 'bogus', { config: {} }), 'Error');
  assert.equal(wheel('Save Token', 'token', { value: 50 }), '');
  assert.equal(wheel('Save Token', 'token', { value: -1 }), 'Error');
  assert.equal(r.call('@nav-0092734', { action: 'ADD-REDEEM', path: 'redeem', key: 'r1', config: { duration: 3600, points: 50, type: 'consumable' } }), '');
  assert.equal(r.call('@nav-0092734', { action: 'ADD-REDEEM', path: 'redeem', key: '../x', config: {} }), 'Error');
  assert.equal(r.call('@nav-0092734', { action: 'GET' }).redeem.r1.points, 50);
  r.call('@nav-0092734', { action: 'REMOVE-REDEEM', path: 'redeem', key: 'r1' });
  assert.deepEqual(r.call('@nav-0092734', { action: 'GET' }).redeem, {});
  for (const path of ['vendo', 'voucher', 'credit']) {
    assert.equal(r.call('@nav-0092734', { action: 'SET', path, coin: 5, point: 1.5 }), '');
    r.call('@nav-0092734', { action: 'SET', path, coin: 5, point: 2 });
    assert.deepEqual(r.call('@nav-0092734', { action: 'GET' })[path], [{ coin: 5, point: 2 }], 'setting a coin twice replaces it');
    r.call('@nav-0092734', { action: 'DELETE', path, coin: 5 });
    assert.deepEqual(r.call('@nav-0092734', { action: 'GET' })[path], []);
  }
  for (const bad of [{ action: 'SET', path: 'other', coin: 5, point: 1 }, { action: 'SET', path: 'vendo', coin: 0, point: 1 }, { action: 'SET', path: 'vendo', coin: 5, point: 0 }, { action: 'nuke' }, null]) assert.equal(r.call('@nav-0092734', bad), 'Error', JSON.stringify(bad));
});

test('portal-side leftovers answer without data; sub-vendo activation is declined', () => {
  const r = rig();
  assert.deepEqual(r.call('@nav-36547111', { action: 'GET' }), []);
  assert.deepEqual(r.call('@nav-3265800', { action: 'GET' }), {});
  assert.equal(r.call('@nav-14433211', { voucher: 'x' }).success, false);
});

test('a settings file from an older version (missing keys) still gives a complete object', () => {
  const r = rig();
  fs.writeFileSync(r.file, JSON.stringify({ main: { name: 'Old' } }));
  const a = r.call('@nav-22114');
  assert.equal(a.vendoInfo.sub.main.name, 'Old');
  assert.equal(a.vendoInfo.sub.main.countdownMax, 15);
  assert.deepEqual(a.vendoInfo.sub.main.config.rate, []);
});

test('themes: licence note, the two shipped themes, set/unset, and the portal script with its enable switch', () => {
  const r = rig();
  assert.deepEqual(r.call('@nav-32024512', { action: 'ctheme' }), { allowed: true });
  const l = r.call('@nav-32024512', { action: 'GetList' });
  assert.deepEqual(Object.keys(l.list.themes), ['defualt-theme', 'newTheme']);
  assert.equal(l.allowed.newTheme.activate, 'activated');
  assert.equal(l.set, '');
  assert.equal(r.call('@nav-32024512', { action: 'set', name: 'newTheme' }), 'Success');
  assert.equal(r.call('@nav-32024512', { action: 'GetList' }).set, 'newTheme');
  assert.equal(r.call('@nav-32024512', { action: 'set', name: '../x' }), 'Unknown theme');
  assert.equal(r.call('@nav-32024512', { action: 'unset', name: 'newTheme' }), 'Success');
  assert.equal(r.call('@nav-453648', { action: 'GET2-ENABLE' }), true);
  r.call('@nav-453648', { action: 'SET2-ENABLE', enable: false });
  assert.equal(r.call('@nav-453648', { action: 'GET2-ENABLE' }), false);
  assert.deepEqual(r.call('@nav-453648', { action: 'SET2', theme: 'console.log(1)', password: 'pw' }), { success: 'Success' });
  assert.equal(r.call('@nav-453648', { action: 'GET2' }), 'console.log(1)');
  assert.deepEqual(r.call('@nav-453648', { action: 'SET2', theme: 'x' }), { success: 'Success' }, 'no vendor password offline');
  assert.deepEqual(r.call('@nav-453648', { action: 'SET2', theme: 'x'.repeat(20001), password: 'pw' }), { err: 'The script is too long' });
  assert.deepEqual(r.call('@nav-453648', { action: 'SET2' }), { success: 'Theme disabled' });
  assert.equal(r.call('@nav-453648', { action: 'GET2' }), '');
});

test('sub-vendo section: requests, accept, rename, describe, countdown, remove, online', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createVendos } = require('../lib/vendos');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5ws-')), 'settings.json');
  const settings = createSettings({ file, deviceName: 'ETHYLNET', coinPin: 17 });
  const vendos = createVendos({ settings });
  const h = createSettingsHandlers({ settings, vendos, deviceName: 'ETHYLNET', mainlog: { write: () => {} } });
  const call = (id, p) => h[id].handler(p, {});
  vendos.request('A1B2C3', { mac: 'aa:00:00:00:00:01', iface: 'vlan10', ip: '10.1.0.50' });
  let r = call('@nav-22125');
  assert.deepEqual(r.request, [{ id: 'A1B2C3', name: 'SubVendo-A1B2C3', mac: 'aa:00:00:00:00:01' }]);
  assert.deepEqual(Object.keys(r.vendoInfo.sub), ['main']);
  call('@nav-22126', { action: 'edit-key', key: 'ABCDEFGHIJKLMN' }); // a 14-char key is required before any accept (signatures)
  call('@nav-22126', { action: 'accept-sub-vendo', id: 'A1B2C3' });
  call('@nav-22126', { action: 'edit-name-sub-vendo', id: 'sub1', name: 'Kanto Vendo' });
  call('@nav-22126', { action: 'edit-description-sub-vendo', id: 'sub1', description: 'near the store' });
  call('@nav-22126', { action: 'set-coundown', id: 'sub1', countdownMax: 30 });
  vendos.seen('sub1', { version: '1.0.0', interface: 'vlan10' });
  r = call('@nav-22125');
  assert.deepEqual(r.request, []);
  const s = r.vendoInfo.sub.sub1;
  assert.deepEqual([s.name, s.description, s.countdownMax, s.mac, s.license], ['Kanto Vendo', 'near the store', 30, 'aa:00:00:00:00:01', 'Offline']);
  assert.deepEqual(r.vendoOnline.sub1, { version: '1.0.0', interface: 'vlan10' });
  assert.ok(r.vendoOnline.main);
  assert.equal(settings.read().main.name, 'ETHYLNET', 'renaming a sub-vendo leaves main alone');
  call('@nav-22126', { action: 'remove-sub-vendo', id: 'sub1' });
  assert.deepEqual(Object.keys(call('@nav-22125').vendoInfo.sub), ['main']);
});
