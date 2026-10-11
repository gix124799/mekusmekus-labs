const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUci } = require('../lib/system/uci');

const emu = () => createUci({ runCommand: () => { throw new Error('no ubus'); }, stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5uci-')), 'u.json'), hasUbus: false });

test('get: whole config, one section, one option, by type; missing things say "Not found"', () => {
  const u = emu();
  assert.ok(Object.keys(u.call('get', { config: 'network' }).values).includes('lan'));
  assert.equal(u.call('get', { config: 'network', section: 'lan' }).values.ipaddr, '192.168.1.1');
  assert.equal(u.call('get', { config: 'network', section: 'lan', option: 'proto' }).value, 'static');
  assert.deepEqual(Object.keys(u.call('get', { config: 'network', type: 'device' }).values), ['br_lan']);
  assert.deepEqual(u.call('get', { config: 'network', section: 'nope' }), { stdout: '', stderr: 'Command failed: Not found' });
  assert.match(u.call('get', { config: 'nothing' }).stderr, /Not found/);
  assert.match(u.call('get', { config: 'network', section: 'lan', option: 'zzz' }).stderr, /Not found/);
});

test('set/add/delete are staged: visible to reads, listed by changes, dropped by revert, kept by commit', () => {
  const u = emu();
  assert.deepEqual(u.call('changes', { config: 'network' }), {}, 'a clean config has no changes');
  assert.deepEqual(u.call('set', { config: 'network', section: 'wan', values: { proto: 'static', ipaddr: '10.0.0.2' } }), { stdout: '', stderr: '' });
  assert.equal(u.call('get', { config: 'network', section: 'wan' }).values.ipaddr, '10.0.0.2');
  const added = u.call('add', { config: 'network', type: 'interface', name: 'static_x', values: { proto: 'static', ipaddr: '1.2.3.4', netmask: '255.255.255.0' } });
  assert.deepEqual(added, { section: 'static_x' });
  assert.equal(u.call('add', { config: 'network', type: 'interface', values: {} }).section.startsWith('cfg'), true, 'an unnamed section gets a cfg id');
  u.call('delete', { config: 'network', section: 'wan', option: 'ipaddr' });
  const ch = u.call('changes', { config: 'network' }).changes;
  assert.deepEqual(ch.map((c) => c[0]), ['set', 'set', 'add', 'add', 'remove']);
  u.call('revert', { config: 'network' });
  assert.equal(u.call('get', { config: 'network', section: 'wan' }).values.proto, 'dhcp');
  assert.deepEqual(u.call('changes', { config: 'network' }), {});
  u.call('set', { config: 'network', section: 'wan', values: { proto: 'static' } });
  u.call('commit', { config: 'network' });
  u.call('revert', { config: 'network' });
  assert.equal(u.call('get', { config: 'network', section: 'wan' }).values.proto, 'static', 'a committed change survives a revert');
});

test('committed state is saved and read back by a new instance', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5uci-')), 'u.json');
  const mk = () => createUci({ runCommand: () => '', stateFile: file, hasUbus: false });
  const a = mk();
  a.call('set', { config: 'system', section: 'cfg0', values: { hostname: 'SHOP' } });
  a.call('commit', { config: 'system' });
  assert.equal(mk().call('get', { config: 'system', section: 'cfg0', option: 'hostname' }).value, 'SHOP');
});

test('input is validated: bad names, options, values, configs and verbs never change anything', () => {
  const u = emu();
  const before = JSON.stringify(u.call('get', { config: 'network' }));
  for (const bad of [
    ['set', { config: 'network', section: 'wan', values: { 'bad key!': 'x' } }],
    ['set', { config: 'network', section: 'wan', values: { '.type': 'x' } }],
    ['set', { config: 'network', section: 'wan', values: { a: { nested: 1 } } }],
    ['set', { config: 'network', section: '../x', values: { a: 'b' } }],
    ['set', { config: 'network', section: 'wan', values: [] }],
    ['add', { config: 'network', type: 'bad type', values: {} }],
    ['add', { config: 'network', type: 'interface', name: 'wan', values: {} }],
    ['delete', { config: 'network', section: 'nope' }],
    ['set', { config: 'passwd', section: 'x', values: { a: 'b' } }],
    ['frobnicate', { config: 'network' }],
  ]) assert.ok(u.call(...bad).stderr, JSON.stringify(bad));
  assert.equal(JSON.stringify(u.call('get', { config: 'network' })), before);
});

test('with ubus the calls go to ubus as one argv each; its JSON comes back, empty output is {stdout:"",stderr:""}, failures keep their message', () => {
  const calls = [];
  const out = { get: '{"values":{"a":1}}', set: '', add: '{"section":"cfg1"}' };
  const u = createUci({ runCommand: (a) => { calls.push(a); if (a[4] === '{"config":"zzz"}') { const e = new Error('x'); e.stderr = 'Command failed: Not found\n'; throw e; } return out[a[3]] ?? ''; }, stateFile: '/nonexistent/u.json', hasUbus: true });
  assert.deepEqual(u.call('get', { config: 'network' }), { values: { a: 1 } });
  assert.deepEqual(u.call('set', { config: 'network' }), { stdout: '', stderr: '' });
  assert.deepEqual(u.call('add', { config: 'network' }), { section: 'cfg1' });
  assert.deepEqual(u.call('get', { config: 'zzz' }), { stdout: '', stderr: 'Command failed: Not found' });
  assert.deepEqual(calls[0], ['ubus', 'call', 'uci', 'get', '{"config":"network"}']);
  assert.equal(u.emulated, false);
});
