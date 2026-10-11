# Admin Dashboard — Live Logs & Session Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live log viewer and manual session actions (revoke, comp-credit) to the existing `/admin` dashboard, with auto-refresh so the admin never has to reload the page.

**Architecture:** Extends three existing files (`lib/logger.js`, `lib/session.js`, `lib/portal.js`) plus a one-line wiring change in `main.js`. No new process, no new dependency, no router library — same hand-rolled `node:http` route-matching style already used throughout `lib/portal.js`.

**Tech Stack:** Node.js (`node:http`, `node:test`, `node:assert`), no external packages.

**Spec:** `docs/superpowers/specs/2026-10-11-admin-dashboard-design.md`

## Global Constraints

- No new runtime dependency (spec: "No new runtime dependency, no new process, no router library").
- `lib/logger.js`'s `log(level, message, fields)` signature and existing behavior (writes to `out`, default `process.stdout`) must not change — its 3 existing callers (`main.js`, `lib/gpio.js`, `lib/firewall.js`) are untouched.
- Ring buffer capacity is exactly 500 entries (spec: `CAPACITY = 500`).
- Comp-credit only targets a MAC already present in `session.all()` — no free-text MAC entry (spec, scope decision).
- Dashboard polling interval is 2000ms (spec: "Client-side polling (2s)").
- Revoke order: `firewall.revoke(mac)` first; only on success do `session.revoke(mac)` + `session.save()`. On failure, session state is untouched (spec: Error handling, the one deliberate reordering).
- Comp-credit order: `session.addCredit(...)` first, then `firewall.allow(mac)` in a try/catch that only logs on failure — mirrors the existing `onPulse()` ordering in `main.js:81-88` exactly; do not "fix" the inherited gap (spec: Error handling).
- Every manual action (success or failure) writes one audit log line via `log()` with `{ action, mac, pesos?, admin: true }` in its fields (spec: scope + data flow).

## Review Focus

- **Revoking a MAC with no active session:** expect 404, and neither `session.revoke` nor any firewall call happens — a stale "Revoke" click from a now-expired row must not throw or log a spurious audit line.
- **Comp-credit with an invalid amount (zero, negative, non-numeric, missing):** expect 400, no mutation — the spec only says "positive finite number"; a reasonable person expects the server to reject garbage, not silently coerce it.
- **`firewall.revoke` throwing must leave the session store completely untouched:** this is the core safety property behind the spec's one deliberate reordering decision — if this regresses, the dashboard could show a session as gone while the firewall still grants that client internet access.
- **The ring buffer caps at exactly 500 and drops the oldest entry first, not the newest** — and this must be entirely independent of what still gets written to `out`; a reasonable person expects old log noise, not the newest incident, to fall off first, and expects existing log-to-stdout behavior for the 3 existing callers to keep working unchanged.
- **Every new admin route (`/admin/api/logs`, the two `/admin/api/sessions/:mac/...` routes) must 401 without a valid session cookie** — the easiest mistake when copy-pasting the existing route-matching style is to forget the `isAdminSession()` check on a new route, which would let any unauthenticated LAN client revoke other customers' sessions or grant themselves free credit.

---

### Task 1: `lib/logger.js` — ring buffer and `getRecent()`

**Files:**
- Modify: `lib/logger.js` (currently 8 lines, full file)
- Test: `test/logger.test.js` (append to existing file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `getRecent()` — returns an array of up to 500 entries, each shaped `{ ...fields, ts, level, message }` (same shape `log()` already writes to `out`), oldest first, newest last. Later tasks (3) import this.

- [ ] **Step 1: Write the failing tests**

Append to `test/logger.test.js`:

```javascript
const { log, getRecent } = require('../lib/logger');

test('getRecent returns entries pushed by log, oldest first', () => {
  const before = getRecent().length;
  log('info', 'first', {}, sink());
  log('info', 'second', {}, sink());
  const recent = getRecent();
  assert.equal(recent.length, before + 2);
  assert.equal(recent[recent.length - 2].message, 'first');
  assert.equal(recent[recent.length - 1].message, 'second');
});

test('getRecent caps at 500 entries and drops the oldest first', () => {
  for (let i = 0; i < 520; i++) log('info', `msg-${i}`, {}, sink());
  const recent = getRecent();
  assert.equal(recent.length, 500);
  assert.equal(recent[0].message, 'msg-19'); // oldest of the last 500 written
  assert.equal(recent[recent.length - 1].message, 'msg-519');
});

test('getRecent entries are independent of what out receives', () => {
  const out = sink();
  log('warn', 'only-to-buffer-and-out', { x: 1 }, out);
  const recent = getRecent();
  const last = recent[recent.length - 1];
  assert.equal(last.message, 'only-to-buffer-and-out');
  assert.equal(last.x, 1);
  assert.ok(out.data.includes('only-to-buffer-and-out')); // out still got it too
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/logger.test.js`
Expected: FAIL — `getRecent is not a function` (or `undefined`).

- [ ] **Step 3: Write the implementation**

Replace the full contents of `lib/logger.js`:

```javascript
const LEVELS = ['debug', 'info', 'warn', 'error'];
const CAPACITY = 500;
const recent = []; // module-level ring buffer; same singleton pattern as lib/config.js's `loaded`

function log(level, message, fields = {}, out = process.stdout) {
  if (!LEVELS.includes(level)) throw new Error(`unknown log level: ${level}`);
  const entry = { ...fields, ts: new Date().toISOString(), level, message };
  out.write(JSON.stringify(entry) + '\n');
  recent.push(entry);
  if (recent.length > CAPACITY) recent.shift();
}

function getRecent() {
  return recent.slice();
}

module.exports = { log, getRecent, LEVELS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/logger.test.js`
Expected: PASS (all tests, including the 3 pre-existing ones — signature and `out` behavior are unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/logger.js test/logger.test.js
git commit -m "feat: add log ring buffer and getRecent() for the admin dashboard"
```

---

### Task 2: `lib/session.js` — `revoke(mac)`

**Files:**
- Modify: `lib/session.js:62-64` (the `all()` function and the `return` statement right after it)
- Test: `test/session.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `revoke(mac)` — deletes `mac` from the in-memory store, returns `true` if it existed, `false` otherwise. Does not call `save()`. Later task (4) calls this.

- [ ] **Step 1: Write the failing tests**

Append to `test/session.test.js`:

```javascript
test('revoke removes an existing session and returns true', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('m1', 5, 1, 1000);
  assert.equal(s.revoke('m1'), true);
  assert.equal(s.getSession('m1'), undefined);
});

test('revoke on an unknown mac returns false and is a no-op', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  assert.equal(s.revoke('never-existed'), false);
  assert.deepEqual(s.all(), {});
});

test('revoke does not call save() itself (caller\'s responsibility)', () => {
  const file = tmpFile();
  const s = createSessionStore(file);
  s.load();
  s.addCredit('m1', 5, 1, 1000);
  s.save(); // the one save we expect on disk
  const before = fs.readFileSync(file, 'utf8');
  s.revoke('m1'); // no save() call after this
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(before, after); // file unchanged -- revoke alone never touched disk
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session.test.js`
Expected: FAIL — `s.revoke is not a function`.

- [ ] **Step 3: Write the implementation**

In `lib/session.js`, add `revoke` right before the existing `all` function (around line 62), and add it to the returned object:

```javascript
  function revoke(mac) {
    if (!(mac in sessions)) return false;
    delete sessions[mac];
    return true;
  }

  function all() {
    return { ...sessions };
  }

  return { load, save, addCredit, getSession, isActive, expireDue, revoke, all };
```

(Only the `revoke` function and the `return` line's added `revoke,` are new — everything else in the file, including the existing `all` function, is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session.test.js`
Expected: PASS (all tests, including pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add lib/session.js test/session.test.js
git commit -m "feat: add session.revoke(mac) for admin-initiated session termination"
```

---

### Task 3: `lib/portal.js` — thread `firewall` into `createServer`, add `GET /admin/api/logs`

**Files:**
- Modify: `lib/portal.js:1-3` (imports), `lib/portal.js:145` (the `createServer` signature), `lib/portal.js:219-224` (insert the new route right after the existing `/admin/api/sessions` route)
- Test: `test/portal.test.js` (append)

**Interfaces:**
- Consumes: `getRecent()` from `lib/logger.js` (Task 1); `firewall` object with `allow(mac)`/`revoke(mac)` (already defined in `lib/firewall.js`, unchanged).
- Produces: `createServer({ session, firewall, arp, ratePesosPerMinute, adminAuth })` — `firewall` is now a parameter (tasks 4-5 use it). `GET /admin/api/logs` route, admin-only.

- [ ] **Step 1: Write the failing test**

Append to `test/portal.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/portal.test.js`
Expected: FAIL — `GET /admin/api/logs` falls through to the catch-all route and returns the client page HTML (status 200, but not JSON array), so `JSON.parse` throws, or the 401 assertion fails because the route doesn't exist yet to reject anything.

- [ ] **Step 3: Write the implementation**

In `lib/portal.js`, after the existing 3 `require` lines (1-3: `node:http`, `node:fs`, `node:path`), add the logger import:

```javascript
const { getRecent } = require('./logger');
```

Change the `createServer` signature on line 145 from:

```javascript
function createServer({ session, arp, ratePesosPerMinute, adminAuth }) {
```

to:

```javascript
function createServer({ session, firewall, arp, ratePesosPerMinute, adminAuth }) {
```

Immediately after the existing `/admin/api/sessions` route block (ends around line 224, right before the `/api/pay-intent` block), insert:

```javascript
    if (req.method === 'GET' && req.url === '/admin/api/logs') {
      if (!isAdminSession()) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRecent()));
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/portal.test.js`
Expected: PASS (all tests, including every pre-existing one — no existing test passes `firewall`, and none of them exercise the new route or any code path that uses it, so adding the parameter is safe).

- [ ] **Step 5: Commit**

```bash
git add lib/portal.js test/portal.test.js
git commit -m "feat: thread firewall into createServer; add GET /admin/api/logs"
```

---

### Task 4: `lib/portal.js` — `POST /admin/api/sessions/:mac/revoke` + dashboard button

**Files:**
- Modify: `lib/portal.js` (the `dashboardContent` function, currently lines 86-100; the route table, right after the block added in Task 3)
- Test: `test/portal.test.js` (append)

**Interfaces:**
- Consumes: `firewall.revoke(mac)` (throws on failure, per `lib/firewall.js`'s existing contract); `session.revoke(mac)` (Task 2); `log()` from `lib/logger.js`.
- Produces: nothing new consumed by later tasks (Task 5 is independent; Task 6 only reads the HTML this task adds, not its internals).

- [ ] **Step 1: Write the failing tests**

Append to `test/portal.test.js`:

```javascript
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
    const res = await request(port, 'POST', '/admin/api/sessions/unknown-mac/revoke', { headers: { Cookie: 'vendo5_admin=tok123' } });
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
    all: () => ({ m1: { mac: 'm1', creditPesos: 5, expiresAt: Date.now() + 60000 } }),
    revoke: (mac) => { order.push(['session.revoke', mac]); return true; },
    save: () => { order.push(['session.save']); },
  };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/m1/revoke', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.deepEqual(firewall.calls, [['revoke', 'm1']]);
    assert.deepEqual(order, [['session.revoke', 'm1'], ['session.save']]);
  } finally {
    server.close();
  }
});

test('POST revoke, firewall.revoke throws: session state is left completely untouched', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const firewall = fakeFirewall({ revokeThrows: true });
  const sessionStore = {
    ...fakeSession(false),
    all: () => ({ m1: { mac: 'm1', creditPesos: 5, expiresAt: Date.now() + 60000 } }),
    revoke: () => { throw new Error('must not be called when firewall.revoke throws'); },
    save: () => { throw new Error('must not be called when firewall.revoke throws'); },
  };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/m1/revoke', { headers: { Cookie: 'vendo5_admin=tok123' } });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { ok: false });
  } finally {
    server.close();
  }
});

test('POST revoke requires a valid admin session', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const sessionStore = { ...fakeSession(false), all: () => ({ m1: { mac: 'm1', creditPesos: 5, expiresAt: Date.now() + 60000 } }) };
  const { server } = createServer({ session: sessionStore, firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/m1/revoke');
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/portal.test.js`
Expected: FAIL — the route doesn't exist (every revoke request falls through to the catch-all and returns the client page, so status/body assertions fail), and the dashboard HTML has no `data-revoke-mac` attribute yet.

- [ ] **Step 3: Write the implementation**

In `lib/portal.js`, replace the `dashboardContent` function (currently lines 86-100) with:

```javascript
function dashboardContent(sessionsByMac, now = Date.now()) {
  const list = Object.values(sessionsByMac);
  const total = list.reduce((n, s) => n + s.creditPesos, 0);
  const rows = list.map((s) => {
    const remaining = Math.max(0, Math.round((s.expiresAt - now) / 1000));
    return `<tr data-mac-row="${escapeHtml(s.mac)}"><td>${escapeHtml(s.mac)}</td><td>${s.creditPesos}</td><td>${remaining}s</td>` +
      `<td><button data-revoke-mac="${escapeHtml(s.mac)}" class="ghost">Revoke</button></td></tr>`;
  }).join('');
  return `<div class="card">
<h2>Active Sessions: ${list.length} &middot; Credit: &#8369;${total}</h2>
<table><thead><tr><th>MAC</th><th>Credit (&#8369;)</th><th>Remaining</th><th></th></tr></thead>
<tbody id="sessions-tbody">${rows || '<tr><td colspan="4">No active sessions</td></tr>'}</tbody></table>
</div>
<div class="top"><span></span><button id="logout-btn" class="ghost">Logout</button></div>`;
}
```

(Only the `<td>` adding the Revoke button, and the `data-mac-row`/colspan adjustment, are new — the rest of the function is unchanged.)

Right after the `GET /admin/api/logs` block added in Task 3, insert:

```javascript
    const revokeMatch = req.url.match(/^\/admin\/api\/sessions\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revokeMatch) {
      if (!isAdminSession()) { res.writeHead(401).end(); return; }
      const targetMac = decodeURIComponent(revokeMatch[1]);
      if (!(targetMac in session.all())) { res.writeHead(404).end(); return; }
      try {
        firewall.revoke(targetMac);
      } catch (e) {
        log('error', 'admin revoke failed', { action: 'revoke', mac: targetMac, admin: true, error: e.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      session.revoke(targetMac);
      session.save();
      log('info', 'admin revoke', { action: 'revoke', mac: targetMac, admin: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
```

This requires `log` to be imported — add it next to the `getRecent` import from Task 3:

```javascript
const { log } = require('./logger');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/portal.test.js`
Expected: PASS (all tests, including every pre-existing one).

- [ ] **Step 5: Commit**

```bash
git add lib/portal.js test/portal.test.js
git commit -m "feat: admin can revoke a session now; firewall checked before session state changes"
```

---

### Task 5: `lib/portal.js` — `POST /admin/api/sessions/:mac/credit` + dashboard form

**Files:**
- Modify: `lib/portal.js` (`dashboardContent` again; the route table)
- Test: `test/portal.test.js` (append)

**Interfaces:**
- Consumes: `session.addCredit(mac, pesos, ratePesosPerMinute)` (existing, unchanged); `firewall.allow(mac)` (existing); `log()`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `test/portal.test.js`:

```javascript
test('POST credit on an unknown mac returns 404 and makes no session/firewall call', async () => {
  const adminAuth = fakeAdminAuth('tok123');
  const firewall = fakeFirewall();
  const sessionStore = { ...fakeSession(false), all: () => ({}), addCredit: () => { throw new Error('must not be called'); } };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/unknown-mac/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: 5 }) });
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
    const sessionStore = { ...fakeSession(false), all: () => ({ m1: { mac: 'm1', creditPesos: 1, expiresAt: Date.now() + 60000 } }), addCredit: () => { throw new Error('must not be called'); } };
    const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
    const port = await listen(server);
    try {
      const res = await request(port, 'POST', '/admin/api/sessions/m1/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: bad }) });
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
    all: () => ({ m1: { mac: 'm1', creditPesos: 1, expiresAt: Date.now() + 60000 } }),
    addCredit: (mac, pesos, rate) => { order.push(['addCredit', mac, pesos, rate]); },
    save: () => { order.push(['save']); },
  };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 2, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/m1/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: 7 }) });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.deepEqual(order, [['addCredit', 'm1', 7, 2], ['save']]);
    assert.deepEqual(firewall.calls, [['allow', 'm1']]);
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
    all: () => ({ m1: { mac: 'm1', creditPesos: 1, expiresAt: Date.now() + 60000 } }),
    addCredit: () => { creditCalled = true; },
    save: () => { saveCalled = true; },
  };
  const { server } = createServer({ session: sessionStore, firewall, arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/m1/credit', { headers: { Cookie: 'vendo5_admin=tok123', 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: 3 }) });
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
  const sessionStore = { ...fakeSession(false), all: () => ({ m1: { mac: 'm1', creditPesos: 1, expiresAt: Date.now() + 60000 } }) };
  const { server } = createServer({ session: sessionStore, firewall: fakeFirewall(), arp: fakeArp('m1'), ratePesosPerMinute: 1, adminAuth });
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/admin/api/sessions/m1/credit', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pesos: 3 }) });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/portal.test.js`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Write the implementation**

In `lib/portal.js`, right after the revoke route block from Task 4, insert:

```javascript
    const creditMatch = req.url.match(/^\/admin\/api\/sessions\/([^/]+)\/credit$/);
    if (req.method === 'POST' && creditMatch) {
      if (!isAdminSession()) { res.writeHead(401).end(); return; }
      const targetMac = decodeURIComponent(creditMatch[1]);
      if (!(targetMac in session.all())) { res.writeHead(404).end(); return; }
      readJsonBody(req).then(({ pesos }) => {
        if (typeof pesos !== 'number' || !Number.isFinite(pesos) || pesos <= 0) {
          res.writeHead(400).end();
          return;
        }
        session.addCredit(targetMac, pesos, ratePesosPerMinute);
        try {
          firewall.allow(targetMac);
        } catch (e) {
          log('error', 'admin credit: firewall allow failed', { action: 'credit', mac: targetMac, pesos, admin: true, error: e.message });
        }
        session.save();
        log('info', 'admin credit', { action: 'credit', mac: targetMac, pesos, admin: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
```

Add a comp-credit form to `dashboardContent`'s per-row markup — extend the `<td>` holding the Revoke button from Task 4:

```javascript
    return `<tr data-mac-row="${escapeHtml(s.mac)}"><td>${escapeHtml(s.mac)}</td><td>${s.creditPesos}</td><td>${remaining}s</td>` +
      `<td><button data-revoke-mac="${escapeHtml(s.mac)}" class="ghost">Revoke</button> ` +
      `<input data-credit-input="${escapeHtml(s.mac)}" type="number" min="1" step="1" style="width:4em;"> ` +
      `<button data-credit-mac="${escapeHtml(s.mac)}" class="ghost">Add credit</button></td></tr>`;
```

(This replaces only the single `return` line inside the `.map()` from Task 4 — the rest of `dashboardContent` is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/portal.test.js`
Expected: PASS (all tests, including every pre-existing one).

- [ ] **Step 5: Commit**

```bash
git add lib/portal.js test/portal.test.js
git commit -m "feat: admin can grant comp credit to an existing session"
```

---

### Task 6: `lib/portal.js` — dashboard auto-refresh and log panel

**Files:**
- Modify: `lib/portal.js` (`dashboardContent` — add the log panel markup; add a new `DASHBOARD_JS` constant next to the existing `LOGIN_JS`/`LOGOUT_JS`; the `adminPage` call site that picks which script to inject)
- Test: `test/portal.test.js` (append)

**Interfaces:**
- Consumes: the `data-revoke-mac`/`data-credit-mac`/`data-credit-input` attributes from Tasks 4-5 (by name, in the injected JS's `querySelectorAll`/`dataset` lookups).
- Produces: nothing consumed by later tasks (this is the last portal.js task).

- [ ] **Step 1: Write the failing tests**

Append to `test/portal.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/portal.test.js`
Expected: FAIL — no `id="logs-panel"` element exists yet.

- [ ] **Step 3: Write the implementation**

In `lib/portal.js`, add a log panel to the end of `dashboardContent`'s returned markup (right before the closing `<div class="top">` line added in earlier tasks):

```javascript
  return `<div class="card">
<h2>Active Sessions: ${list.length} &middot; Credit: &#8369;${total}</h2>
<table><thead><tr><th>MAC</th><th>Credit (&#8369;)</th><th>Remaining</th><th></th></tr></thead>
<tbody id="sessions-tbody">${rows || '<tr><td colspan="4">No active sessions</td></tr>'}</tbody></table>
</div>
<div class="card"><h2>Recent Activity</h2><pre id="logs-panel" style="max-height:300px;overflow:auto;"></pre></div>
<div class="top"><span></span><button id="logout-btn" class="ghost">Logout</button></div>`;
```

Add a new constant next to `LOGIN_JS`/`LOGOUT_JS`:

```javascript
const DASHBOARD_JS = `
${LOGOUT_JS}
function renderSessions(s) {
  var tbody = document.getElementById('sessions-tbody');
  var macs = Object.keys(s);
  tbody.innerHTML = macs.length ? macs.map(function (mac) {
    var row = s[mac];
    var remaining = Math.max(0, Math.round((row.expiresAt - Date.now()) / 1000));
    return '<tr><td>' + mac + '</td><td>' + row.creditPesos + '</td><td>' + remaining + 's</td>' +
      '<td><button data-revoke-mac="' + mac + '" class="ghost">Revoke</button> ' +
      '<input data-credit-input="' + mac + '" type="number" min="1" step="1" style="width:4em;"> ' +
      '<button data-credit-mac="' + mac + '" class="ghost">Add credit</button></td></tr>';
  }).join('') : '<tr><td colspan="4">No active sessions</td></tr>';
  wireActionButtons();
}
function renderLogs(lines) {
  document.getElementById('logs-panel').textContent = lines.map(function (l) { return JSON.stringify(l); }).join('\\n');
}
function wireActionButtons() {
  document.querySelectorAll('[data-revoke-mac]').forEach(function (btn) {
    btn.onclick = function () { post('/admin/api/sessions/' + btn.dataset.revokeMac + '/revoke').then(refresh); };
  });
  document.querySelectorAll('[data-credit-mac]').forEach(function (btn) {
    btn.onclick = function () {
      var mac = btn.dataset.creditMac;
      var input = document.querySelector('[data-credit-input="' + mac + '"]');
      post('/admin/api/sessions/' + mac + '/credit', { pesos: Number(input.value) }).then(refresh);
    };
  });
}
function refresh() {
  fetch('/admin/api/sessions').then(function (r) { return r.json(); }).then(renderSessions);
  fetch('/admin/api/logs').then(function (r) { return r.json(); }).then(renderLogs);
}
wireActionButtons();
refresh();
setInterval(refresh, 2000);`;
```

Update the `adminPage` call site (currently picks `LOGOUT_JS` vs `LOGIN_JS` based on `loggedIn`) to use `DASHBOARD_JS` instead of `LOGOUT_JS` when logged in:

```javascript
function adminPage(content, loggedIn) {
  return shell('Admin | MekusMekus Vendo', `<div class="wrap wide">
<img class="banner" src="/theme/banner.jpg" alt="MekusMekus Labs">
${content}
</div>`, loggedIn ? DASHBOARD_JS : LOGIN_JS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/portal.test.js`
Expected: PASS (all tests, including every pre-existing one — `DASHBOARD_JS` includes the existing `LOGOUT_JS` content verbatim, so the pre-existing logout behavior is preserved).

- [ ] **Step 5: Commit**

```bash
git add lib/portal.js test/portal.test.js
git commit -m "feat: dashboard auto-refreshes sessions and logs every 2s"
```

---

### Task 7: `main.js` wiring + end-to-end integration test

**Files:**
- Modify: `main.js:65` (the `createServer` call)
- Test: `test/main.test.js` (append)

**Interfaces:**
- Consumes: everything from Tasks 1-6, through the real `main.js` boot sequence.
- Produces: nothing — this is the final, capstone task.

- [ ] **Step 1: Write the failing test**

Append to `test/main.test.js`. This mirrors the existing "a paid coin pulse credits the session..." test's setup, then adds an admin login + revoke call — the kind of end-to-end wiring bug (like the `password_hash`/`passwordHash` mismatch the existing admin-login test caught) that only shows up when the real `main.js` is actually running, not from unit tests with fakes:

```javascript
test('admin revoke, end to end: a paid session can be revoked via the real admin API, and the firewall/session file reflect it', async () => {
  const configDir = tmpDir();
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5sessfile-')), 'sessions.json');
  const gpioBase = fakeGpioBase();
  const mac = 'aa:bb:cc:dd:ee:ff';

  const r = run({
    VENDO5_CONFIG_DIR: configDir,
    VENDO5_DEFAULTS_DIR: DEFAULTS,
    VENDO5_SESSION_FILE: sessionFile,
    VENDO5_GPIO_BASE: gpioBase,
    VENDO5_PORTAL_PORT: '0',
    VENDO5_FIREWALL_CMD: 'noop',
    VENDO5_ARP_FAKE_MAC: mac,
  });
  await new Promise((res) => r.p.stdout.once('data', res));
  await waitFor(r, /portal listening/);
  const portLine = /"port":(\d+)/.exec(r.out());
  const port = Number(portLine[1]);

  try {
    // Pay a coin so there's a real active session to revoke.
    await new Promise((resolve, reject) => {
      const req = http.request({ port, method: 'POST', path: '/api/pay-intent' }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end();
    });
    const pinDir = path.join(gpioBase, 'gpio17');
    fs.writeFileSync(path.join(pinDir, 'value'), '1');
    await waitFor(r, /firewall allow/);

    // Log in as admin to get a real session cookie.
    const loginRes = await new Promise((resolve, reject) => {
      const req = http.request({ port, method: 'POST', path: '/admin/login', headers: { 'Content-Type': 'application/json' } }, (resp) => {
        let body = '';
        resp.on('data', (c) => { body += c; });
        resp.on('end', () => resolve({ body, headers: resp.headers }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ username: 'admin', password: 'admin' }));
    });
    assert.deepEqual(JSON.parse(loginRes.body), { ok: true });
    const cookie = loginRes.headers['set-cookie'][0].split(';')[0];

    // Revoke it through the real admin API.
    const revokeRes = await new Promise((resolve, reject) => {
      const req = http.request({ port, method: 'POST', path: `/admin/api/sessions/${mac}/revoke`, headers: { Cookie: cookie } }, (resp) => {
        let body = '';
        resp.on('data', (c) => { body += c; });
        resp.on('end', () => resolve({ status: resp.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(revokeRes.status, 200);
    assert.deepEqual(JSON.parse(revokeRes.body), { ok: true });

    await waitFor(r, /"message":"admin revoke"/);
    r.p.kill('SIGTERM');
    await r.exited;

    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(saved[mac], undefined); // revoked session is gone from the persisted file
  } finally {
    if (!r.exited) r.p.kill('SIGTERM');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/main.test.js`
Expected: FAIL — `main.js` doesn't pass `firewall` into `createServer`, so the revoke call hits a `TypeError` (firewall is undefined) inside the route handler, producing a 500 or an uncaught exception rather than the expected 200.

- [ ] **Step 3: Write the implementation**

In `main.js`, change line 65 from:

```javascript
const { server, consumePendingPayer } = createServer({ session, arp, ratePesosPerMinute: pesos_per_minute, adminAuth });
```

to:

```javascript
const { server, consumePendingPayer } = createServer({ session, firewall, arp, ratePesosPerMinute: pesos_per_minute, adminAuth });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/main.test.js`
Expected: PASS (all tests, including every pre-existing one).

Then run the full suite to confirm nothing else regressed:

Run: `node --test test/*.test.js`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add main.js test/main.test.js
git commit -m "feat: wire firewall into the portal so admin revoke/credit work end to end"
```
