const test = require('node:test');
const assert = require('node:assert');
const { createPortalOps } = require('../lib/money/portal-ops');
const { createSessionStore } = require('../lib/session');

test('free trials are capped per hour for the whole vendo', () => {
  const sessions = createSessionStore('/nonexistent/s.json');
  sessions.load();
  let t = 1000000;
  const used = new Set();
  const ops = createPortalOps({
    sessions,
    firewall: { allow: () => {}, revoke: () => {} },
    clients: { trialUsed: (m) => used.has(m), markTrial: (m) => used.add(m) },
    trialMaxPerHour: 2,
    now: () => t,
  });
  const trial = { minutes: 5 };
  assert.equal(ops.trial('m1', trial), 'Connected');
  t += 60000;
  assert.equal(ops.trial('m2', trial), 'Connected');
  assert.equal(ops.trial('m3', trial), 'Free trial limit reached, try again later');
  assert.equal(used.has('m3'), false, 'a refused trial is not marked as used');
  t = 1000000 + 3600000;
  assert.equal(ops.trial('m3', trial), 'Connected', 'the first trial left the window');
  assert.equal(ops.trial('m4', trial), 'Free trial limit reached, try again later');
});

test('without a cap the trial works as before', () => {
  const sessions = createSessionStore('/nonexistent/s.json');
  sessions.load();
  const ops = createPortalOps({ sessions, firewall: { allow: () => {} }, clients: { trialUsed: () => false, markTrial: () => {} } });
  for (let i = 0; i < 20; i++) assert.equal(ops.trial(`m${i}`, { minutes: 5 }), 'Connected');
});
