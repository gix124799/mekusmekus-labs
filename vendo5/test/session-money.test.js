const test = require('node:test');
const assert = require('node:assert');
const { createSessionStore } = require('../lib/session');

const store = () => { const s = createSessionStore('/nonexistent/s.json'); s.load(); return s; };
const T = 1000000;

test('addTime starts a session with the voucher fields, and extends a live one without replacing it', () => {
  const s = store();
  s.addTime('m1', 60000, { price: 5, code: 'AB12', type: 'pausable', upload: '1M', download: '2M', pauselimit: 2, validityHours: 1 }, T);
  const a = s.getSession('m1');
  assert.equal(a.expiresAt, T + 60000);
  assert.equal(a.creditPesos, 5);
  assert.equal(a.type, 'pausable');
  assert.equal(a.validityEnd, T + 3600000);
  s.addTime('m1', 30000, { price: 2 }, T + 1000);
  assert.equal(s.getSession('m1').expiresAt, T + 90000);
  assert.equal(s.getSession('m1').creditPesos, 7);
  assert.equal(s.getSession('m1').type, 'pausable');
});

test('addTime on an expired session starts fresh from now', () => {
  const s = store();
  s.addTime('m1', 1000, {}, T);
  s.addTime('m1', 5000, {}, T + 9000);
  assert.equal(s.getSession('m1').expiresAt, T + 14000);
});

test('pause freezes the remaining time and stops the session counting; resume restores it from now', () => {
  const s = store();
  s.addTime('m1', 60000, { type: 'pausable', pauselimit: 1 }, T);
  assert.deepEqual(s.pause('m1', T + 10000).ok, true);
  assert.equal(s.getSession('m1').remainingMs, 50000);
  assert.equal(s.isActive('m1', T + 20000), false);
  assert.deepEqual(s.expireDue(T + 999999999), [], 'a paused session does not expire');
  assert.equal(s.resume('m1', T + 500000).ok, true);
  assert.equal(s.getSession('m1').expiresAt, T + 550000);
  assert.equal(s.isActive('m1', T + 500001), true);
  assert.equal(s.pause('m1', T + 500002).ok, false, 'no pauses left');
});

test('only a pausable session can pause; unknown or already paused is refused', () => {
  const s = store();
  s.addTime('m1', 60000, { type: 'consumable' }, T);
  assert.match(s.pause('m1', T).reason, /cannot be paused/);
  assert.equal(s.pause('nobody', T).ok, false);
  assert.equal(s.resume('m1', T).ok, false);
});

test('time added while paused goes into the frozen remainder; extend does too', () => {
  const s = store();
  s.addTime('m1', 60000, { type: 'pausable' }, T);
  s.pause('m1', T + 10000);
  s.addTime('m1', 5000, {}, T + 20000);
  s.extend('m1', 1000, T + 20000);
  s.addCredit('m1', 1, 1, T + 20000); // a coin: +1 minute
  assert.equal(s.getSession('m1').remainingMs, 50000 + 5000 + 1000 + 60000);
});

test('a passed validity window ends even a paused session', () => {
  const s = store();
  s.addTime('m1', 60000, { type: 'pausable', validityHours: 1 }, T);
  s.pause('m1', T + 1000);
  assert.deepEqual(s.expireDue(T + 3600001), ['m1']);
});

test('restore puts a session back exactly, or removes it', () => {
  const s = store();
  s.addTime('m1', 60000, {}, T);
  const snap = structuredClone(s.getSession('m1'));
  s.addTime('m1', 60000, {}, T);
  s.restore('m1', snap);
  assert.equal(s.getSession('m1').expiresAt, T + 60000);
  s.restore('m1', null);
  assert.equal(s.getSession('m1'), undefined);
});
