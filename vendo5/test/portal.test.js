const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../lib/portal');

function fakeSession(active) {
  return {
    isActive: () => active,
    getSession: () => (active ? { mac: 'm1', expiresAt: Date.now() + 60000 } : undefined),
  };
}
function fakeArp(mac) {
  return { ipToMac: () => mac };
}
function recordingArp(mac) {
  const calls = [];
  return { arp: { ipToMac: (ip) => { calls.push(ip); return mac; } }, calls };
}
function sequencedArp(macs) {
  let i = 0;
  return { ipToMac: () => macs[Math.min(i++, macs.length - 1)] };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}
function request(port, method, path, { headers, body: reqBody } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(reqBody);
  });
}
function fakeAdminAuth(validToken) {
  return {
    login: (u, p) => (u === 'admin' && p === 'secret' ? validToken : null),
    verify: (t) => t === validToken,
    logout: () => {},
  };
}

test('client IP is normalized before ARP lookup (IPv6-mapped IPv4 strips the ::ffff: prefix)', async () => {
  const { arp, calls } = recordingArp('m1');
  const { server } = createServer({ session: fakeSession(false), arp, ratePesosPerMinute: 1 });
  const port = await listen(server);
  await request(port, 'GET', '/');
  server.close();
  assert.ok(calls.length >= 1, 'arp.ipToMac was never called');
  assert.ok(!calls[0].startsWith('::ffff:'), `expected a stripped IPv4, got ${calls[0]}`);
});

// Real-frontend ruling: GET / now serves the real app's single SPA shell
// (same for paid/unpaid), matching the actual decrypted frontend's design
// — status is conveyed by client-side JS polling /api/status, never by
// server-rendered HTML branching per state. Supersedes the earlier
// landing/online page split.
test('GET / always serves the real page shell with the real insert-coin button', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /insert coin/i);
  assert.match(res.body, /id="client-insert-coin"/);
  server.close();
});

// Regression: the inline script called toastada.show(msg, type), but the
// real toast.js (public/theme/js/toast.js) only exposes .success/.info/
// .warning/.error -- no .show() at all. That threw inside the click
// handler's success callback in a real browser, silently (no console in
// our Node test runner), making the insert-coin button look broken even
// though the network request itself went through.
test('GET / does not call the nonexistent toastada.show (only real toast.js methods)', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/');
    assert.doesNotMatch(res.body, /toastada\.show\(/);
    assert.match(res.body, /toastada\.(success|info|warning|error)\(/);
  } finally {
    server.close();
  }
});

test('GET / does not throw when the MAC is unresolved (arp returns null)', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp(null), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /insert coin/i);
  server.close();
});

test('GET /admin without a session shows the login form, not the dashboard', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/admin');
    assert.equal(res.status, 200);
    assert.match(res.body, /<title>Admin/);
    assert.match(res.body, /id="admin-login-form"/);
  } finally {
    server.close();
  }
});

test('POST /admin/login with correct credentials sets a session cookie; wrong credentials are rejected', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const bad = await request(port, 'POST', '/admin/login', { body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
    assert.deepEqual(JSON.parse(bad.body), { ok: false });

    const good = await request(port, 'POST', '/admin/login', { body: JSON.stringify({ username: 'admin', password: 'secret' }) });
    assert.deepEqual(JSON.parse(good.body), { ok: true });
    assert.match(good.headers['set-cookie'][0], /vendo5_admin=tok123/);
  } finally {
    server.close();
  }
});

test('GET /admin with a valid session cookie shows the real dashboard (active sessions list)', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(true), all: () => ({ m1: { mac: 'm1', creditPesos: 5, expiresAt: Date.now() + 60000 } }) };
  const { server } = createServer({ session: sessionStore, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/admin', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body, /id="admin-login-form"/);
    assert.match(res.body, /m1/);
    assert.match(res.body, />5</); // creditPesos shown
  } finally {
    server.close();
  }
});

test('GET /admin with an invalid cookie still shows the login form', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/admin', { headers: { Cookie: 'vendo5_admin=not-the-real-token' } });
    assert.match(res.body, /id="admin-login-form"/);
  } finally {
    server.close();
  }
});

test('GET /admin/api/sessions requires a valid admin session', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(false), all: () => ({ m1: { mac: 'm1', creditPesos: 2, expiresAt: 999 } }) };
  const { server } = createServer({ session: sessionStore, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const unauth = await request(port, 'GET', '/admin/api/sessions');
    assert.equal(unauth.status, 401);

    const auth = await request(port, 'GET', '/admin/api/sessions', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(auth.status, 200);
    assert.deepEqual(JSON.parse(auth.body), { m1: { mac: 'm1', creditPesos: 2, expiresAt: 999 } });
  } finally {
    server.close();
  }
});

test('POST /api/pay-intent records the pending payer; a single pulse consumes it', async () => {
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'POST', '/api/pay-intent');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(consumePendingPayer(), 'm1');
  server.close();
});

// Ruling (code-review fix pass): the plan's own Interfaces block for Task 4
// said consumePendingPayer "clears it" on first use, but the plan's own
// Review Focus #1 requires back-to-back coin pulses for the SAME payer to
// both credit via top-up. Those two statements contradict each other; the
// spec (binding authority) backs Review Focus #1, so consumePendingPayer
// now "touches" (refreshes) the window on each successful pulse instead of
// clearing it, and only a real TTL lapse (no further pulses) frees the slot.
test('a second pulse for the same payer within TTL still finds the pending payer (supports back-to-back coins)', async () => {
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  try {
    await request(port, 'POST', '/api/pay-intent');
    assert.equal(consumePendingPayer(0), 'm1');
    assert.equal(consumePendingPayer(5000), 'm1'); // second pulse, still within TTL of the first
  } finally {
    server.close();
  }
});

test('the pending payer expires once the TTL truly elapses with no further pulses', async () => {
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  try {
    await request(port, 'POST', '/api/pay-intent');
    assert.equal(consumePendingPayer(0), 'm1');
    assert.equal(consumePendingPayer(20000), null); // no pulse refreshed it; TTL (10s) lapsed
  } finally {
    server.close();
  }
});

test('a different MAC cannot override an active pending payer within TTL', async () => {
  const arp = sequencedArp(['m1', 'm2']);
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp, ratePesosPerMinute: 1 });
  const port = await listen(server);
  try {
    const res1 = await request(port, 'POST', '/api/pay-intent'); // resolves to m1
    const res2 = await request(port, 'POST', '/api/pay-intent'); // resolves to m2, m1 still pending
    assert.deepEqual(JSON.parse(res1.body), { ok: true });
    assert.deepEqual(JSON.parse(res2.body), { ok: false });
    assert.equal(consumePendingPayer(), 'm1');
  } finally {
    server.close();
  }
});

test('consumePendingPayer returns null when none was set', async () => {
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  server.close();
  assert.equal(consumePendingPayer(), null);
});

test('GET /api/status reflects active session remaining time', async () => {
  const { server } = createServer({ session: fakeSession(true), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/api/status');
  const body = JSON.parse(res.body);
  assert.equal(body.active, true);
  assert.ok(body.remainingSeconds > 0);
  server.close();
});

test('GET /api/status reflects unpaid', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/api/status');
  const body = JSON.parse(res.body);
  assert.equal(body.active, false);
  server.close();
});

test('GET /admin/api/logs requires a valid admin session and returns getRecent()', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const unauth = await request(port, 'GET', '/admin/api/logs');
    assert.equal(unauth.status, 401);

    const auth = await request(port, 'GET', '/admin/api/logs', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(auth.status, 200);
    assert.ok(Array.isArray(JSON.parse(auth.body)));
  } finally {
    server.close();
  }
});

function fakeFirewall({ revokeThrows = false, allowThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    revoke: (mac) => { calls.push(['revoke', mac]); if (revokeThrows) throw new Error('nft: revoke failed'); },
    allow: (mac) => { calls.push(['allow', mac]); if (allowThrows) throw new Error('nft: allow failed'); },
  };
}

test('POST revoke on an unknown mac returns 404 and makes no firewall call', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const firewall = fakeFirewall();
  const sessionStore = { ...fakeSession(false), all: () => ({}), revoke: () => { throw new Error('must not be called'); } };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/00:00:00:00:00:99/revoke', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(res.status, 404);
    assert.deepEqual(firewall.calls, []);
  } finally {
    server.close();
  }
});

test('POST revoke, success path: firewall.revoke before session.revoke, in that order', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const firewall = fakeFirewall();
  const order = [];
  const sessionStore = {
    ...fakeSession(false),
    all: () => ({ 'a1:a1:a1:a1:a1:a1': { mac: 'a1:a1:a1:a1:a1:a1', creditPesos: 5, expiresAt: Date.now() + 60000 } }),
    revoke: (mac) => { order.push(['session.revoke', mac]); return true; },
    save: () => { order.push(['session.save']); },
  };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/a1:a1:a1:a1:a1:a1/revoke', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.deepEqual(firewall.calls, [['revoke', 'a1:a1:a1:a1:a1:a1']]);
    assert.deepEqual(order, [['session.revoke', 'a1:a1:a1:a1:a1:a1'], ['session.save']]);
  } finally {
    server.close();
  }
});

test('POST revoke, firewall.revoke throws: session state is left completely untouched', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const firewall = fakeFirewall({ revokeThrows: true });
  const sessionStore = {
    ...fakeSession(false),
    all: () => ({ 'a1:a1:a1:a1:a1:a1': { mac: 'a1:a1:a1:a1:a1:a1', creditPesos: 5, expiresAt: Date.now() + 60000 } }),
    revoke: () => { throw new Error('must not be called when firewall.revoke throws'); },
    save: () => { throw new Error('must not be called when firewall.revoke throws'); },
  };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/a1:a1:a1:a1:a1:a1/revoke', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { ok: false });
  } finally {
    server.close();
  }
});

test('POST revoke requires a valid admin session', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(false), all: () => ({ 'a1:a1:a1:a1:a1:a1': { mac: 'a1:a1:a1:a1:a1:a1', creditPesos: 5, expiresAt: Date.now() + 60000 } }) };
  const { server } = createServer({ session: sessionStore, firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/a1:a1:a1:a1:a1:a1/revoke');
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('dashboard HTML includes a Revoke control per session row', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(true), all: () => ({ m1: { mac: 'm1', creditPesos: 5, expiresAt: Date.now() + 60000 } }) };
  const { server } = createServer({ session: sessionStore, firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/admin', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.match(res.body, /data-revoke-mac="m1"/);
  } finally {
    server.close();
  }
});

test('POST credit on an unknown mac returns 404 and makes no session/firewall call', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const firewall = fakeFirewall();
  const sessionStore = { ...fakeSession(false), all: () => ({}), addCredit: () => { throw new Error('must not be called'); } };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/00:00:00:00:00:99/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: 5 }) });
    assert.equal(res.status, 404);
    assert.deepEqual(firewall.calls, []);
  } finally {
    server.close();
  }
});

for (const bad of [0, -1, 'five', null, undefined, NaN]) {
  test(`POST credit rejects invalid pesos value: ${JSON.stringify(bad)}`, async () => {
    const adminAuth = fakeAdminAuth('tok123');
    const firewall = fakeFirewall();
    const sessionStore = { ...fakeSession(false), all: () => ({ 'a1:a1:a1:a1:a1:a1': { mac: 'a1:a1:a1:a1:a1:a1', creditPesos: 1, expiresAt: Date.now() + 60000 } }), addCredit: () => { throw new Error('must not be called'); } };
    const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
    const port = await listen(server);
    try {
      const res = await request(port, 'POST', '/admin/api/sessions/a1:a1:a1:a1:a1:a1/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: bad }) });
      assert.equal(res.status, 400);
      assert.deepEqual(firewall.calls, []);
    } finally {
      server.close();
    }
  });
}

test('POST credit, success path: session.addCredit before firewall.allow', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const firewall = fakeFirewall();
  const order = [];
  const sessionStore = {
    ...fakeSession(false),
    all: () => ({ 'a1:a1:a1:a1:a1:a1': { mac: 'a1:a1:a1:a1:a1:a1', creditPesos: 1, expiresAt: Date.now() + 60000 } }),
    addCredit: (mac, pesos, rate) => { order.push(['addCredit', mac, pesos, rate]); },
    save: () => { order.push(['save']); },
  };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 2, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/a1:a1:a1:a1:a1:a1/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: 7 }) });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.deepEqual(order, [['addCredit', 'a1:a1:a1:a1:a1:a1', 7, 2], ['save']]);
    assert.deepEqual(firewall.calls, [['allow', 'a1:a1:a1:a1:a1:a1']]);
  } finally {
    server.close();
  }
});

test('POST credit, firewall.allow throws: credit is kept, not rolled back', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const firewall = fakeFirewall({ allowThrows: true });
  let creditCalled = false;
  let saveCalled = false;
  const sessionStore = {
    ...fakeSession(false),
    all: () => ({ 'a1:a1:a1:a1:a1:a1': { mac: 'a1:a1:a1:a1:a1:a1', creditPesos: 1, expiresAt: Date.now() + 60000 } }),
    addCredit: () => { creditCalled = true; },
    save: () => { saveCalled = true; },
  };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/a1:a1:a1:a1:a1:a1/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: 3 }) });
    assert.equal(res.status, 200); // still 200 -- credit was kept, only the firewall call failed
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(creditCalled, true);
    assert.equal(saveCalled, true);
  } finally {
    server.close();
  }
});

test('POST credit requires a valid admin session', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(false), all: () => ({ 'a1:a1:a1:a1:a1:a1': { mac: 'a1:a1:a1:a1:a1:a1', creditPesos: 1, expiresAt: Date.now() + 60000 } }) };
  const { server } = createServer({ session: sessionStore, firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/a1:a1:a1:a1:a1:a1/credit', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: 3 }) });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('dashboard includes a log panel element and the polling script, logged in only', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(true), all: () => ({}) };
  const { server } = createServer({ session: sessionStore, firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const loggedIn = await request(port, 'GET', '/admin', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.match(loggedIn.body, /id="logs-panel"/);
    assert.match(loggedIn.body, /\/admin\/api\/logs/);
    assert.match(loggedIn.body, /setInterval/);

    const loggedOut = await request(port, 'GET', '/admin');
    assert.doesNotMatch(loggedOut.body, /id="logs-panel"/); // login form has no dashboard, no polling
  } finally {
    server.close();
  }
});

// Final-review fix: a malformed percent-encoded mac segment must not reach
// decodeURIComponent (it threw a URIError that crashed the whole process,
// since nothing catches it inside the request handler). The mac route
// pattern is hex/colon only, so this no longer matches the route at all and
// falls through to the harmless catch-all instead of crashing.
test('POST to a malformed percent-encoded mac path does not crash the server', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const { server } = createServer({ session: fakeSession(false), firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/%E0/revoke', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(res.status, 200); // falls through to the catch-all client page, not a crash
    // server must still be alive and answering afterward
    const after = await request(port, 'GET', '/api/status');
    assert.equal(after.status, 200);
  } finally {
    server.close();
  }
});

// Final-review fix: a mac segment containing non-hex letters (e.g. a
// Object.prototype member name like "constructor"/"toString") must not
// match the route at all, so it can never reach the `in session.all()`
// check that used to treat inherited property names as "found".
test('POST revoke/credit with a non-hex mac segment does not match the route or touch session/firewall', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const firewall = fakeFirewall();
  const sessionStore = {
    ...fakeSession(false),
    all: () => ({}),
    revoke: () => { throw new Error('must not be called'); },
    addCredit: () => { throw new Error('must not be called'); },
  };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const revokeRes = await request(port, 'POST', '/admin/api/sessions/constructor/revoke', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(revokeRes.status, 200); // catch-all, not treated as a hit
    const creditRes = await request(port, 'POST', '/admin/api/sessions/toString/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: 5 }) });
    assert.equal(creditRes.status, 200); // catch-all, not treated as a hit
    assert.deepEqual(firewall.calls, []);
  } finally {
    server.close();
  }
});

// Final-review fix: readJsonBody used to resolve the literal parsed value
// (e.g. `null` for a body of "null"), and the credit handler's
// `({ pesos }) => ...` destructure throws a TypeError on null -- an
// unhandled rejection inside a .then() callback, which crashes the process
// the same way the login route's identical bug did (see main test below).
test('POST credit with a JSON body of null does not crash; returns 400', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(false), all: () => ({ 'a1:a1:a1:a1:a1:a1': { mac: 'a1:a1:a1:a1:a1:a1', creditPesos: 1, expiresAt: Date.now() + 60000 } }) };
  const { server } = createServer({ session: sessionStore, firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/a1:a1:a1:a1:a1:a1/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: 'null' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

// Final-review fix: the same readJsonBody bug above is reachable,
// unauthenticated, through /admin/login -- a body of "null" destructures
// `({ username, password })` from `null` and throws. Pre-existing bug, not
// introduced by this plan, but the fix is the same one line.
test('POST /admin/login with a JSON body of null does not crash; returns ok:false', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const { server } = createServer({ session: fakeSession(false), firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/login', { headers: { 'Content-Type': 'application/json' }, body: 'null' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: false });
  } finally {
    server.close();
  }
});

// Final-review fix: the admin cookie had no SameSite attribute, so a
// cross-site POST (CSRF) to the new revoke/credit routes would carry it on
// browsers whose default is not Lax, and even Lax's two-minute post-login
// relaxation window. SameSite=Strict closes that off.
test('admin login cookie is SameSite=Strict', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const { server } = createServer({ session: fakeSession(false), firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/login', { body: JSON.stringify({ username: 'admin', password: 'secret' }) });
    assert.match(res.headers['set-cookie'][0], /SameSite=Strict/);
  } finally {
    server.close();
  }
});

// Final-review fix: auto-refresh replaced the whole sessions tbody every
// 2s, wiping whatever an admin had typed into a comp-credit amount input
// before they could click "Add credit". The client JS must preserve a
// non-empty input's value across a re-render for the same mac.
test('dashboard JS preserves an in-progress credit input value across a sessions re-render', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(true), all: () => ({}) };
  const { server } = createServer({ session: sessionStore, firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/admin', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.match(res.body, /preserved\[/); // captures existing input values before replacing innerHTML
  } finally {
    server.close();
  }
});

// Final-review fix: refresh()/the action buttons swallowed every failure --
// an empty 401/404/500 body made the shared post() helper's old `r.json()`
// throw (unhandled rejection), so a logged-out admin's dashboard just froze
// silently instead of reloading to the login form, and a failed
// revoke/credit gave no feedback at all.
test('dashboard JS reloads on an unauthorized poll and toasts a failed action', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(true), all: () => ({}) };
  const { server } = createServer({ session: sessionStore, firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/admin', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.match(res.body, /status === 401/);
    assert.match(res.body, /location\.reload/);
    assert.match(res.body, /toastada\.error/);
  } finally {
    server.close();
  }
});
