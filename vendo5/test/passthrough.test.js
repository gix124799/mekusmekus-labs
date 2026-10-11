const test = require('node:test');
const assert = require('node:assert');
const { createPassthrough } = require('../lib/wire/passthrough');

const make = (out = '{"uptime":5,"a":1}', net) => {
  const calls = [];
  let rebooted = 0;
  const run = createPassthrough({ runCommand: (a) => { calls.push(a); return out; }, reboot: () => { rebooted++; }, systemInfo: () => ({ uptime: 7 }), net });
  return { run, calls, rebooted: () => rebooted };
};

test('system info runs a fixed argv and answers the parsed JSON', () => {
  const t = make();
  assert.deepEqual(t.run('ubus call system info'), { uptime: 5, a: 1 });
  assert.deepEqual(t.calls, [['ubus', 'call', 'system', 'info']]);
});

test('anything the network allowlist does not know is refused without running a thing', () => {
  const t = make('{}', () => undefined);
  for (const bad of ['rm -rf /', 'ubus call system info; reboot', 'ubus call network.interface.wan status && id', '', null, undefined, 5, {}, ['ubus']]) assert.deepEqual(t.run(bad), {}, String(bad));
  assert.equal(t.calls.length, 0);
  assert.equal(t.rebooted(), 0);
});

test('other lines go to the network allowlist and its answer is returned as is', () => {
  const seen = [];
  const t = make('{}', (line) => { seen.push(line); return line === 'x' ? ['a'] : undefined; });
  assert.deepEqual(t.run('x'), ['a']);
  assert.deepEqual(t.run('y'), {});
  assert.deepEqual(seen, ['x', 'y']);
});

test('reboot answers an empty stdout and triggers the reboot hook once', () => {
  const t = make();
  assert.deepEqual(t.run('ubus call system reboot'), { stdout: '' });
  assert.equal(t.rebooted(), 1);
});

test('system info falls back to /proc figures when ubus fails or answers without an uptime', () => {
  assert.deepEqual(make('not json').run('ubus call system info'), { uptime: 7 });
  const run = createPassthrough({ runCommand: () => { throw new Error('ubus: not found'); }, reboot() {}, systemInfo: () => ({ uptime: 9 }) });
  assert.deepEqual(run('ubus call system info'), { uptime: 9 });
  assert.deepEqual(run('anything else'), {});
});
