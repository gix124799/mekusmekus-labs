const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNetCommands, shape } = require('../lib/system/netcmd');
const { createUci } = require('../lib/system/uci');

function rig({ ubus = false, out = '', throws = null } = {}) {
  const calls = [];
  const runCommand = (a) => { calls.push(a); if (throws) { const e = new Error('boom'); e.stderr = throws; throw e; } return typeof out === 'function' ? out(a) : out; };
  const uci = createUci({ runCommand, stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5nc-')), 'u.json'), hasUbus: ubus });
  return { run: createNetCommands({ runCommand, uci }), calls, uci };
}

test('shape: JSON stays JSON (object and array), other text stays text, nothing becomes {stdout,stderr}', () => {
  assert.deepEqual(shape('{"a":1}\n', ''), { a: 1 });
  assert.deepEqual(shape('[1,2]', ''), [1, 2]);
  assert.equal(shape('interface: wg0\n  peer: x', ''), 'interface: wg0\n  peer: x');
  assert.equal(shape('{not json', ''), '{not json');
  assert.deepEqual(shape('', 'bad'), { stdout: '', stderr: 'bad' });
});

test('uci lines go to the uci module with their JSON; bad JSON or shape is an error answer, not a crash', () => {
  const r = rig();
  assert.equal(r.run('ubus call uci get \'{"config":"network","section":"lan"}\'').values.ipaddr, '10.0.0.1');
  assert.deepEqual(r.run('ubus call uci set \'{"config":"network","section":"lan","values":{"ipaddr":"10.1.1.1"}}\''), { stdout: '', stderr: '' });
  assert.equal(r.run('ubus call uci get \'{"config":"network","section":"lan","option":"ipaddr"}\'').value, '10.1.1.1');
  assert.equal(r.run('ubus call uci get \'{nope\'').stderr, 'Invalid JSON');
  assert.equal(r.run('ubus call uci get \'[1]\'').stderr, 'Invalid argument');
  assert.equal(r.run('ubus call uci get \'{"config":5}\'').stderr, 'Invalid argument');
  assert.equal(r.run('ubus call uci frob \'{}\''), undefined);
});

test('read-only commands become fixed argvs, and failures keep their message', () => {
  const r = rig({ ubus: true, out: '{"x":1}' });
  assert.deepEqual(r.run('ubus call network.interface.wan2 status'), { x: 1 });
  assert.deepEqual(r.run('ubus call network.device status \'{ "name": "eth0" }\''), { x: 1 });
  assert.deepEqual(r.run('ubus call network.device status'), { x: 1 });
  assert.deepEqual(r.run('ubus call network.wireless status'), { x: 1 });
  r.run('ip -j neigh'); r.run('ip -j route'); r.run('ip -j -d route show table 100'); r.run('ip -j -d link show'); r.run('ip -j -d link show dev br-lan'); r.run('wg show wg0'); r.run('iw dev wlan0 station dump');
  assert.deepEqual(r.calls.map((c) => c.join(' ')), [
    'ubus call network.interface.wan2 status', 'ubus call network.device status {"name":"eth0"}', 'ubus call network.device status', 'ubus call network.wireless status',
    'ip -j neigh show', 'ip -j route show', 'ip -j -d route show table 100', 'ip -j -d link show', 'ip -j -d link show dev br-lan', 'wg show wg0', 'iw dev wlan0 station dump',
  ]);
  const bad = rig({ ubus: true, throws: 'Command failed: Not found\nmore' });
  assert.deepEqual(bad.run('ubus call network.interface.zzz status'), { stdout: '', stderr: 'Command failed: Not found' });
});

test('everything else is refused (undefined) and runs nothing, including shell metacharacters and look-alikes', () => {
  const r = rig({ ubus: true, out: '{}' });
  for (const bad of [
    'rm -rf /', 'ip -j neigh; id', 'ip -j neigh | cat', 'ip route add default via 1.1.1.1', 'ip -j -d link show dev eth0; id', 'ip -j -d link show dev ../x',
    'wg show wg0 private-key', 'wg set wg0', 'wg show', 'iw dev wlan0 scan', 'iw dev wlan0 station dump; id', 'iw dev $(id) station dump',
    'ubus call network.interface.wan status extra', 'ubus call network.interface.1bad status', 'ubus call network.interface.a-b status', 'ubus call network.interface. status',
    'ubus call network.device status \'{ "name": "x; id" }\'', 'ubus call network.device set', 'ubus call system reboot2', 'ubus call file read', 'ubus call service list',
    'ip -j -d route show table abc', 'ip -j -d route show table 123456', '', 'x'.repeat(7000), null, undefined, 5, {},
  ]) assert.equal(r.run(bad), undefined, String(bad).slice(0, 50));
  assert.equal(r.calls.length, 0);
});

test('no ubus: network status is answered from the emulated uci', () => {
  const r = rig();
  const lan = r.run('ubus call network.interface.lan status');
  assert.deepEqual([lan.proto, lan.device, lan['ipv4-address']], ['static', 'br-lan', [{ address: '10.0.0.1', mask: 19 }]]);
  assert.equal(r.run('ubus call network.interface.nope status').stderr, 'Command failed: Not found');
  const w = r.run('ubus call network.wireless status');
  assert.equal(w.radio0.interfaces[0].section, 'default_radio0');
  assert.equal(w.radio0.interfaces[0].ifname, 'wlan0');
  assert.equal(r.run('iw dev wlan0 station dump'), '');
});

test('no ubus: eth0/eth1 stand-ins appear when the machine has none, and real interfaces are kept', () => {
  const r = rig({ out: (a) => (a.join(' ') === 'ip -j -d link show' ? '[{"ifname":"lo"},{"ifname":"eth1","address":"aa:aa:aa:aa:aa:aa"}]' : '[]') });
  const list = r.run('ip -j -d link show');
  assert.deepEqual(list.map((l) => l.ifname), ['lo', 'eth1', 'eth0']);
  assert.equal(list.find((l) => l.ifname === 'eth1').address, 'aa:aa:aa:aa:aa:aa', 'a real one is never replaced');
  assert.equal(r.run('ip -j -d link show dev eth0')[0].qdisc, 'fq_codel');
  assert.equal(r.run('ubus call network.device status \'{ "name": "eth0" }\'').macaddr, '52:54:00:12:34:56');
});
