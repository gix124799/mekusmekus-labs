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
test('client IP is normalized before ARP lookup (IPv6-mapped IPv4 strips the ::ffff: prefix)', async () => {
  const { arp, calls } = recordingArp('m1');
  const { server } = createServer({ session: fakeSession(false), arp, ratePesosPerMinute: 1 });
  const port = await listen(server);
  await request(port, 'GET', '/');
  server.close();
  assert.ok(calls.length >= 1, 'arp.ipToMac was never called');
  assert.ok(!calls[0].startsWith('::ffff:'), `expected a stripped IPv4, got ${calls[0]}`);
});

test('portal HTTP trusts the forwarded client IP only through the local reverse proxy', async () => {
  const { arp, calls } = recordingArp('m1');
  const { server } = createServer({ session: fakeSession(false), arp, ratePesosPerMinute: 1 });
  const port = await listen(server);
  await request(port, 'GET', '/', { headers: { 'x-real-ip': '10.0.0.8' } });
  server.close();
  assert.ok(calls.includes('10.0.0.8'));
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
  assert.match(res.body, /\/theme\/banner\.jpg/);
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

test('admin routes answer before any ARP lookup; a request they decline falls through to the portal', async () => {
  const { arp, calls } = recordingArp('m1');
  const seen = [];
  const adminRoutes = (req, res) => {
    seen.push(req.url);
    if (req.url === '/admin') { res.writeHead(200).end('admin'); return true; }
    return false;
  };
  const { server } = createServer({ session: fakeSession(false), arp, ratePesosPerMinute: 1, adminRoutes });
  const port = await listen(server);
  const admin = await request(port, 'GET', '/admin');
  assert.equal(admin.body, 'admin');
  assert.equal(calls.length, 0, 'serving /admin must not shell out to `ip neigh`');
  const other = await request(port, 'GET', '/generate_204');
  assert.match(other.body, /client-insert-coin/);
  assert.deepEqual(seen, ['/admin', '/generate_204']);
  server.close();
});

test('with no admin routes configured the portal still answers (admin unavailable)', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const r = await request(port, 'GET', '/admin');
  assert.match(r.body, /client-insert-coin/);
  server.close();
});

test('hasPendingPayer looks without refreshing the window', () => {
  const { hasPendingPayer, setPendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  assert.equal(hasPendingPayer(1000), false);
  setPendingPayer('m1', 1000, 5000);
  assert.equal(hasPendingPayer(5000), true);
  assert.equal(hasPendingPayer(6001), false, 'peeking at 5000 did not extend the 5 s window');
});

test('each vendo has its own pending payer: busy at one vendo does not block another', () => {
  const { setPendingPayer, consumePendingPayer, hasPendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  assert.equal(setPendingPayer('m1', 1000, 5000, 'main'), true);
  assert.equal(setPendingPayer('m2', 1000, 5000, 'main'), false, 'one phone at a time per vendo');
  assert.equal(setPendingPayer('m2', 1000, 5000, 'sub1'), true, 'another vendo is free');
  assert.equal(hasPendingPayer(2000, 'sub1'), true);
  assert.equal(consumePendingPayer(2000, 'sub1'), 'm2');
  assert.equal(consumePendingPayer(2000), 'm1', 'main is the default');
});

test('closing the popup frees the vendo after the grace time, not the whole countdown', () => {
  const { setPendingPayer, releasePendingPayer, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  setPendingPayer('m1', 1000, 62000, 'sub1');
  releasePendingPayer('m2', 2000, 1000, 'sub1'); // not the payer: nothing happens
  assert.equal(setPendingPayer('m2', 2500, 62000, 'sub1'), false);
  releasePendingPayer('m1', 3000, 1000, 'sub1');
  assert.equal(consumePendingPayer(3500, 'sub1'), 'm1', 'a coin already falling is still theirs');
  assert.equal(setPendingPayer('m2', 3600, 62000, 'sub1'), false);
  assert.equal(setPendingPayer('m2', 4600, 62000, 'sub1'), true, 'free 1 s after the last activity');
});

test('POST /api/resume-code moves the time to this phone when it has none, and returns its current code', async () => {
  const { createSessionStore } = require('../lib/session');
  const sessions = createSessionStore('/nonexistent/s.json');
  sessions.load();
  sessions.addCredit('old', 5, 1, Date.now());
  const code = sessions.getSession('old').resumeCode;
  const moves = [];
  const money = {
    blocked: () => false,
    moveSession: (mac, c) => { moves.push([mac, c]); return c === code && sessions.move('old', mac) ? { ok: true } : null; },
  };
  const { server } = createServer({ session: sessions, arp: fakeArp('new'), ratePesosPerMinute: 1, money });
  await new Promise((r) => server.listen(0, r));
  const post = (body) => new Promise((resolve) => {
    const req = http.request({ port: server.address().port, path: '/api/resume-code', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); });
    req.end(JSON.stringify(body));
  });
  try {
    assert.deepEqual(await post({ code }), { code, moved: true });
    assert.deepEqual(await post({ code: 'AAAAAAAA' }), { code, moved: false }, 'a phone with time is not moved onto');
    assert.equal(moves.length, 1);
    assert.deepEqual(await post({}), { code, moved: false });
  } finally { server.close(); }
});
