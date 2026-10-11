const test = require('node:test');
const assert = require('node:assert');
const { createPassthrough } = require('../lib/wire/passthrough');

const make = (out = '{"uptime":5,"a":1}') => {
  const calls = [];
  let rebooted = 0;
  const run = createPassthrough({ runCommand: (a) => { calls.push(a); return out; }, reboot: () => { rebooted++; }, systemInfo: () => ({ uptime: 7 }) });
  return { run, calls, rebooted: () => rebooted };
};

test('allowed lines run a fixed argv and answer the parsed JSON', () => {
  const t = make();
  assert.deepEqual(t.run('ubus call system info'), { uptime: 5, a: 1 });
  assert.deepEqual(t.run('ubus call network.interface.wan status'), { uptime: 5, a: 1 });
  assert.deepEqual(t.calls, [['ubus', 'call', 'system', 'info'], ['ubus', 'call', 'network.interface.wan', 'status']]);
});

test('anything else is refused without running a thing, including injection attempts', () => {
  const t = make();
  for (const bad of ['rm -rf /', 'ubus call system info; reboot', 'ubus call network.interface.lan status', 'ubus call network.interface.wan status && id', 'ubus call uci set', '', null, undefined, 5, {}, ['ubus']]) {
    assert.deepEqual(t.run(bad), {}, String(bad));
  }
  assert.equal(t.calls.length, 0);
  assert.equal(t.rebooted(), 0);
});

test('reboot answers an empty stdout and triggers the reboot hook once', () => {
  const t = make();
  assert.deepEqual(t.run('ubus call system reboot'), { stdout: '' });
  assert.equal(t.rebooted(), 1);
});

test('failing or non-JSON output is an empty answer, except system info which falls back to /proc figures', () => {
  assert.deepEqual(make('not json').run('network.interface.wan'), {});
  assert.deepEqual(make('not json').run('ubus call network.interface.wan status'), {});
  assert.deepEqual(make('not json').run('ubus call system info'), { uptime: 7 });
  const run = createPassthrough({ runCommand: () => { throw new Error('ubus: not found'); }, reboot() {}, systemInfo: () => ({ uptime: 9 }) });
  assert.deepEqual(run('ubus call system info'), { uptime: 9 });
  assert.deepEqual(run('ubus call network.interface.wan status'), {});
});
