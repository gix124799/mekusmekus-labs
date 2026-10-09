const test = require('node:test');
const assert = require('node:assert');
const { createArp } = require('../lib/arp');

test('parses a MAC out of a found neighbor entry', () => {
  const runCommand = () => '192.168.1.50 dev br-lan lladdr aa:bb:cc:dd:ee:ff REACHABLE\n';
  assert.equal(createArp(runCommand).ipToMac('192.168.1.50'), 'aa:bb:cc:dd:ee:ff');
});

test('returns null when the command reports no entry', () => {
  const runCommand = () => '';
  assert.equal(createArp(runCommand).ipToMac('192.168.1.99'), null);
});

test('returns null when the command throws (e.g. ip neigh exits nonzero for unknown host)', () => {
  const runCommand = () => { throw new Error('exit 1'); };
  assert.equal(createArp(runCommand).ipToMac('192.168.1.99'), null);
});

test('returns null for a stale/incomplete neighbor entry with no lladdr', () => {
  const runCommand = () => '192.168.1.60 dev br-lan FAILED\n';
  assert.equal(createArp(runCommand).ipToMac('192.168.1.60'), null);
});
