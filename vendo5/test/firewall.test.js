const test = require('node:test');
const assert = require('node:assert');
const { createFirewall } = require('../lib/firewall');

function recorder() {
  const calls = [];
  const runCommand = (args) => { calls.push(args); };
  return { calls, runCommand };
}

test('allow invokes runCommand with the mac', () => {
  const { calls, runCommand } = recorder();
  createFirewall(runCommand).allow('aa:bb:cc:dd:ee:ff');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('aa:bb:cc:dd:ee:ff'));
});

test('revoke invokes runCommand with the mac', () => {
  const { calls, runCommand } = recorder();
  createFirewall(runCommand).revoke('aa:bb:cc:dd:ee:ff');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('aa:bb:cc:dd:ee:ff'));
});

test('allow is idempotent: calling twice for the same mac does not throw', () => {
  const { runCommand } = recorder();
  const fw = createFirewall(runCommand);
  assert.doesNotThrow(() => { fw.allow('m1'); fw.allow('m1'); });
});

test('revoke on a mac that was never allowed does not throw', () => {
  const { runCommand } = recorder();
  assert.doesNotThrow(() => createFirewall(runCommand).revoke('never-allowed'));
});

test('a thrown runCommand error on allow propagates to the caller (caller decides logging)', () => {
  const runCommand = () => { throw new Error('nft: permission denied'); };
  assert.throws(() => createFirewall(runCommand).allow('m1'), /permission denied/);
});

test('syncFromSessions calls allow for every mac in the map', () => {
  const { calls, runCommand } = recorder();
  createFirewall(runCommand).syncFromSessions({
    m1: { mac: 'm1' },
    m2: { mac: 'm2' },
  });
  const macsCalled = calls.map((c) => c.find((a) => a === 'm1' || a === 'm2')).filter(Boolean);
  assert.deepEqual(new Set(macsCalled), new Set(['m1', 'm2']));
});

// Fix (code review Important #5): without a flush first, a MAC whose
// session expired while the service was down (crash/restart) keeps its
// nft rule forever — syncFromSessions only ever adds, never removes.
test('syncFromSessions flushes the allowed set before re-adding kept sessions', () => {
  const { calls, runCommand } = recorder();
  createFirewall(runCommand).syncFromSessions({ m1: { mac: 'm1' } });
  assert.ok(calls[0].includes('flush'), `expected a flush first, got ${JSON.stringify(calls[0])}`);
  assert.ok(calls[1].includes('m1'));
});

test('syncFromSessions still allows kept sessions even if the flush itself fails', () => {
  const calls = [];
  const runCommand = (args) => {
    if (args.includes('flush')) throw new Error('nft: flush failed');
    calls.push(args);
  };
  assert.doesNotThrow(() => createFirewall(runCommand).syncFromSessions({ m1: { mac: 'm1' } }));
  assert.ok(calls.some((c) => c.includes('m1')));
});

test('syncFromSessions continues past one failing mac and still allows the rest', () => {
  const calls = [];
  const runCommand = (args) => {
    if (args.includes('bad-mac')) throw new Error('nft: rule add failed');
    calls.push(args);
  };
  const fw = createFirewall(runCommand);
  assert.doesNotThrow(() => fw.syncFromSessions({
    'bad-mac': { mac: 'bad-mac' },
    'good-mac': { mac: 'good-mac' },
  }));
  assert.ok(calls.some((c) => c.includes('good-mac')));
});
