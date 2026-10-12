const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettings } = require('../lib/store/settings');
const { createVendos } = require('../lib/vendos');

function rig() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5vendos-')), 'settings.json');
  const settings = createSettings({ file, deviceName: 'ETHYLNET', coinPin: 17 });
  let t = 1000000;
  const vendos = createVendos({ settings, now: () => t });
  return { settings, vendos, tick: (ms) => { t += ms; } };
}

test('a request waits in the list until accepted; accept makes sub1, sub2 ...', () => {
  const { vendos, settings } = rig();
  vendos.request('A1B2C3', { mac: 'aa:00:00:00:00:01', iface: 'vlan10', ip: '10.1.0.50' });
  vendos.request('A1B2C3', { mac: 'aa:00:00:00:00:01', iface: 'vlan10', ip: '10.1.0.51' });
  assert.deepEqual(vendos.requests().map((r) => [r.id, r.name, r.mac]), [['A1B2C3', 'SubVendo-A1B2C3', 'aa:00:00:00:00:01']]);
  assert.equal(vendos.accept('A1B2C3'), 'sub1');
  assert.deepEqual(vendos.requests(), []);
  const s = settings.read().sub.sub1;
  assert.equal(s.chip, 'A1B2C3');
  assert.equal(s.iface, 'vlan10');
  assert.equal(s.name, 'Sub Vendo 1');
  assert.equal(s.license, 'Offline');
  assert.equal(s.countdownMax, settings.read().main.countdownMax);
  assert.equal(vendos.byChip('A1B2C3').id, 'sub1');
  vendos.request('D4E5F6', { mac: 'aa:00:00:00:00:02', iface: 'vlan20', ip: '10.2.0.50' });
  assert.equal(vendos.accept('D4E5F6'), 'sub2');
  assert.equal(vendos.accept('NOPE'), null);
});

test('forIface: br-lan, unknown or missing interface is main; a sub-vendo VLAN is that sub-vendo', () => {
  const { vendos } = rig();
  vendos.request('A1B2C3', { mac: 'm', iface: 'vlan10', ip: '' });
  vendos.accept('A1B2C3');
  assert.equal(vendos.forIface('vlan10'), 'sub1');
  assert.equal(vendos.forIface('br-lan'), 'main');
  assert.equal(vendos.forIface('vlan99'), 'main');
  assert.equal(vendos.forIface(undefined), 'main');
  vendos.setIface('sub1', 'vlan30');
  assert.equal(vendos.forIface('vlan30'), 'sub1');
});

test('online for 10 s after a poll; main is always online', () => {
  const { vendos, tick } = rig();
  vendos.request('A1B2C3', { mac: 'm', iface: 'vlan10', ip: '' });
  vendos.accept('A1B2C3');
  assert.equal(vendos.isOnline('main'), true);
  assert.equal(vendos.isOnline('sub1'), false);
  vendos.seen('sub1', { version: '1.0.0', interface: 'vlan10' });
  assert.deepEqual(vendos.online(), { sub1: { version: '1.0.0', interface: 'vlan10' } });
  tick(10001);
  assert.equal(vendos.isOnline('sub1'), false);
  assert.deepEqual(vendos.online(), {});
});

test('rename, describe, countdown and remove a sub-vendo; main cannot be removed', () => {
  const { vendos, settings } = rig();
  vendos.request('A1B2C3', { mac: 'm', iface: 'vlan10', ip: '' });
  vendos.accept('A1B2C3');
  assert.equal(vendos.rename('sub1', 'Kanto Vendo'), true);
  assert.equal(vendos.describe('sub1', 'near the store'), true);
  assert.equal(vendos.setCountdown('sub1', 30), true);
  assert.equal(vendos.rename('nope', 'Kanto Vendo'), false);
  const s = settings.read().sub.sub1;
  assert.deepEqual([s.name, s.description, s.countdownMax], ['Kanto Vendo', 'near the store', 30]);
  assert.equal(vendos.remove('main'), false);
  assert.equal(vendos.remove('sub1'), true);
  assert.equal(vendos.byChip('A1B2C3'), null);
  assert.equal(vendos.get('sub1'), null);
  assert.equal(vendos.get('main').id, 'main');
});
