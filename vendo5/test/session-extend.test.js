const test = require('node:test');
const assert = require('node:assert');
const { createSessionStore } = require('../lib/session');
const { createArp } = require('../lib/arp');

const store = () => { const s = createSessionStore('/nonexistent/s.json'); s.load(); return s; };

test('addCredit records startedAt on a new session only', () => {
  const s = store();
  s.addCredit('m1', 1, 1, 1000);
  s.addCredit('m1', 1, 1, 5000);
  assert.equal(s.getSession('m1').startedAt, 1000);
});

test('extend adds time without adding credit, only to a live session', () => {
  const s = store();
  s.addCredit('m1', 1, 1, 1000); // expires 61000
  assert.equal(s.extend('m1', 30000, 2000).expiresAt, 91000);
  assert.equal(s.getSession('m1').creditPesos, 1);
  assert.equal(s.extend('nobody', 30000, 2000), null);
  assert.equal(s.extend('m1', 30000, 91000), null, 'expired');
  for (const bad of [0, -5, NaN, undefined, '60000']) assert.equal(s.extend('m1', bad, 2000), null, String(bad));
  assert.equal(s.getSession('m1').expiresAt, 91000);
});

test('arp.neighbors maps lower-cased mac to ip and device; garbage lines and failures are ignored', () => {
  const out = '10.0.0.5 dev br-lan lladdr AA:BB:CC:DD:EE:FF REACHABLE\n10.0.0.6 dev br-lan  FAILED\nfe80::1 dev eth0 lladdr 11:22:33:44:55:66 router STALE\nnoise\n';
  assert.deepEqual(createArp(() => out).neighbors(), {
    'aa:bb:cc:dd:ee:ff': { ip: '10.0.0.5', dev: 'br-lan' },
    '11:22:33:44:55:66': { ip: 'fe80::1', dev: 'eth0' },
  });
  assert.deepEqual(createArp(() => { throw new Error('x'); }).neighbors(), {});
});
