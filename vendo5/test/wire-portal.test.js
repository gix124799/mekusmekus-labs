const test = require('node:test');
const assert = require('node:assert');
const { createPortalHandlers } = require('../lib/wire/portal');
const { createSessionStore } = require('../lib/session');

function setup() {
  const sessions = createSessionStore('/nonexistent/s.json');
  sessions.load();
  let t = 100000;
  const h = createPortalHandlers({
    sessions,
    clients: { all: () => ({}) },
    clientLog: { read: () => ({ data: 'Coin: 1 peso(s)\n' }) },
    settings: { read: () => ({ main: { config: { rate: [], set: {} } } }) },
    arp: { neighbors: () => ({}) },
    now: () => t,
  });
  return { h, sessions, at: (x) => { t = x; } };
}
const call = (h, n, p, mac) => h[`@portal-${n}`].handler(p, { mac });

test('the Logs page ends with the resume code while the session is live, not after', () => {
  const { h, sessions, at } = setup();
  sessions.addCredit('m1', 1, 1, 100000);
  const code = sessions.getSession('m1').resumeCode;
  const logs = call(h, 0, undefined, 'm1');
  assert.ok(logs.startsWith('Coin: 1 peso(s)\n'));
  assert.match(logs, new RegExp(`Resume code: ${code} - if your phone changes its MAC, enter this code in the voucher box`));
  at(100000 + 61000);
  assert.equal(call(h, 0, undefined, 'm1'), 'Coin: 1 peso(s)\n');
  assert.equal(call(h, 0, undefined, undefined), '');
});

test('the dashboard code field is the voucher code, else the resume code', () => {
  const { h, sessions } = setup();
  sessions.addCredit('m1', 1, 1, 100000);
  assert.equal(call(h, 2, undefined, 'm1').code, sessions.getSession('m1').resumeCode);
  sessions.addTime('m2', 60000, { code: 'VOUCH1' }, 100000);
  assert.equal(call(h, 2, undefined, 'm2').code, 'VOUCH1');
});
