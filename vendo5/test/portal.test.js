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
