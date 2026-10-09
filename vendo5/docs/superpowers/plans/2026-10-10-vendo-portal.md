# Offline Vendo & Captive Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn GPIO coin pulses into timed internet access: session tracking, firewall-rule enforcement per client MAC, a minimal captive-portal HTTP server, and persistence across reboot.

**Architecture:** One Node process (extends sub-project #1's `main.js`), internally layered into independently testable modules: `session.js` (pure credit/time bookkeeping + persistence), `firewall.js` (shells out to gate clients), `arp.js` (shells out to resolve IP→MAC), `portal.js` (plain `node:http` server). All shell-out modules take an injected `runCommand` so tests never touch the real system.

**Tech Stack:** Node.js v20 (`node:test`, `node:assert`, `node:http`, `node:fs`), same zero-dependency constraint as sub-project #1.

**Spec:** `docs/superpowers/specs/2026-10-09-vendo-portal-design.md`

## Global Constraints

- No npm dependencies (not even dev) — same as sub-project #1.
- No licensing, no cloud/remote calls, no eLoad — out of scope per spec.
- Session file persists on the same durable partition as config
  (`/mnt/wifi5`), so a paying client keeps remaining time across reboot.
- Portal listens on port 3000 (matches reference WiFi5-Soft nginx's
  `upstream backend`).
- Orphaned coin pulse (no pending pay-intent): refuse to credit, log a
  `warn` — never guess the payer.
- Top-up during an active session extends `expiresAt`; never queues a
  second session.
- `vendo.json`'s required keys grow to include `pulse_value_pesos` and
  `pesos_per_minute` alongside the existing `coin_pin`.

## Review Focus

- Two coin pulses arrive back-to-back for the same payer (rapid real
  coin-acceptor chatter): both must credit the same session via top-up,
  not create two unrelated sessions or double-apply as if one pulse.
- A client's IP changes (DHCP lease renewal) mid-session: the firewall
  rule is keyed by MAC, not IP, so access should survive an IP change —
  tests must prove the rule key is MAC, not IP.
- `expireDue` sweep runs while a `pay-intent`/pulse for that same MAC is
  mid-flight (top-up arriving right at expiry): the session shouldn't be
  revoked out from under a payer who is actively extending it.
- Session file on disk has a session whose `expiresAt` is already in the
  past (device was off past a session's expiry): boot must drop it, not
  re-apply a firewall rule for a dead session.
- Portal's `/api/status` or landing page is hit by a client with no ARP
  entry at all (fresh device, first packet): must serve "unpaid" safely,
  not throw and crash the server.

---

### Task 1: Session store

**Files:**
- Create: `lib/session.js`
- Test: `test/session.test.js`

**Interfaces:**
- Produces: `createSessionStore(filePath)` → `{ load(), save(),
  addCredit(mac, pesos, ratePesosPerMinute, now = Date.now()),
  getSession(mac), isActive(mac, now = Date.now()), expireDue(now =
  Date.now()) }`. Session shape: `{ mac, creditPesos, expiresAt }`
  (epoch ms). `addCredit` and `expireDue` call `save()` internally is
  NOT assumed — callers (main.js, later tasks) call `save()` explicitly
  after mutations, keeping this module's I/O boundary at `load`/`save`
  only, matching the spec's "pure bookkeeping, one injected file" design.

- [ ] **Step 1: Write failing test**

`test/session.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore } = require('../lib/session');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5sess-')), 'sessions.json');

test('addCredit creates a new session with correct expiry', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  const now = 1000000;
  s.addCredit('aa:bb:cc:dd:ee:ff', 5, 1, now); // 5 pesos @ 1 peso/min = 5 min
  const sess = s.getSession('aa:bb:cc:dd:ee:ff');
  assert.equal(sess.creditPesos, 5);
  assert.equal(sess.expiresAt, now + 5 * 60000);
});

test('addCredit on an active session extends (top-up), does not queue', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  const now = 1000000;
  s.addCredit('m1', 2, 1, now); // +2 min -> expires now+120000
  s.addCredit('m1', 3, 1, now + 1000); // top-up +3 min while still active
  const sess = s.getSession('m1');
  assert.equal(sess.creditPesos, 5);
  assert.equal(sess.expiresAt, now + 120000 + 180000);
});

test('addCredit on an expired session starts fresh from now, not from old expiry', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('m1', 1, 1, 1000); // expires at 61000
  s.addCredit('m1', 2, 1, 70000); // well after expiry
  const sess = s.getSession('m1');
  assert.equal(sess.creditPesos, 2); // fresh credit, old credit not carried
  assert.equal(sess.expiresAt, 70000 + 120000);
});

test('isActive true before expiry, false at/after', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('m1', 1, 1, 0); // expires at 60000
  assert.equal(s.isActive('m1', 59999), true);
  assert.equal(s.isActive('m1', 60000), false);
  assert.equal(s.isActive('unknown-mac', 0), false);
});

test('expireDue returns and removes only sessions past expiry', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('expired', 1, 1, 0); // expires 60000
  s.addCredit('active', 10, 1, 0); // expires 600000
  const due = s.expireDue(60000);
  assert.deepEqual(due, ['expired']);
  assert.equal(s.getSession('expired'), undefined);
  assert.ok(s.getSession('active'));
});

test('save then load round-trips state', () => {
  const file = tmpFile();
  const s1 = createSessionStore(file);
  s1.load();
  s1.addCredit('m1', 5, 1, 1000);
  s1.save();

  const s2 = createSessionStore(file);
  s2.load();
  const sess = s2.getSession('m1');
  assert.equal(sess.creditPesos, 5);
  assert.equal(sess.expiresAt, 1000 + 300000);
});

test('load drops already-expired sessions found on disk', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    dead: { mac: 'dead', creditPesos: 1, expiresAt: 100 },
    alive: { mac: 'alive', creditPesos: 1, expiresAt: 999999999999 },
  }));
  const s = createSessionStore(file);
  s.load(); // "now" defaults to Date.now(), far past 100
  assert.equal(s.getSession('dead'), undefined);
  assert.ok(s.getSession('alive'));
});

test('load with missing file starts empty, does not throw', () => {
  const s = createSessionStore(path.join(os.tmpdir(), 'v5sess-missing-' + process.pid, 'sessions.json'));
  assert.doesNotThrow(() => s.load());
  assert.equal(s.getSession('anything'), undefined);
});

test('load with corrupt file starts empty, does not throw', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const s = createSessionStore(file);
  assert.doesNotThrow(() => s.load());
  assert.equal(s.getSession('anything'), undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/session.test.js` — Expected: FAIL, cannot find `../lib/session`.

- [ ] **Step 3: Implement**

`lib/session.js`:
```js
const fs = require('node:fs');

function createSessionStore(filePath) {
  let sessions = {}; // mac -> { mac, creditPesos, expiresAt }

  function load(now = Date.now()) {
    sessions = {};
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // missing file: start empty, not an error
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt file: start empty, not an error
    }
    for (const [mac, sess] of Object.entries(parsed)) {
      if (sess.expiresAt > now) sessions[mac] = sess;
    }
  }

  function save() {
    fs.mkdirSync(require('node:path').dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(sessions));
  }

  function getSession(mac) {
    return sessions[mac];
  }

  function isActive(mac, now = Date.now()) {
    const sess = sessions[mac];
    return !!sess && sess.expiresAt > now;
  }

  function addCredit(mac, pesos, ratePesosPerMinute, now = Date.now()) {
    const existing = sessions[mac];
    const minutes = pesos / ratePesosPerMinute;
    if (existing && existing.expiresAt > now) {
      existing.creditPesos += pesos;
      existing.expiresAt += minutes * 60000;
    } else {
      sessions[mac] = { mac, creditPesos: pesos, expiresAt: now + minutes * 60000 };
    }
    return sessions[mac];
  }

  function expireDue(now = Date.now()) {
    const due = [];
    for (const [mac, sess] of Object.entries(sessions)) {
      if (sess.expiresAt <= now) due.push(mac);
    }
    for (const mac of due) delete sessions[mac];
    return due;
  }

  return { load, save, addCredit, getSession, isActive, expireDue };
}

module.exports = { createSessionStore };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/session.test.js` — Expected: 9 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/session.js test/session.test.js
git commit -m "feat: add session store with top-up, expiry, persistence"
```

---

### Task 2: Firewall gate

**Files:**
- Create: `lib/firewall.js`
- Test: `test/firewall.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 directly (wired together in `main.js`,
  Task 5).
- Produces: `createFirewall(runCommand)` → `{ allow(mac), revoke(mac),
  syncFromSessions(sessionsByMac) }`. `runCommand(args: string[])` is
  injected — a function taking an argv-style array, returning nothing
  (or throwing on failure); real implementation shells out to `nft` in
  `main.js`, tests inject a recording fake. `syncFromSessions` takes a
  plain object/map of `mac -> session` (matches what
  `session.js`'s internal store shape looks like from the outside, e.g.
  built from repeated `getSession` calls or exposed as a snapshot — this
  task's tests build the fixture directly, no dependency on Task 1's
  exact internals).

- [ ] **Step 1: Write failing test**

`test/firewall.test.js`:
```js
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
  const macsCalled = calls.map((c) => c.find((a) => a === 'm1' || a === 'm2'));
  assert.deepEqual(new Set(macsCalled), new Set(['m1', 'm2']));
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/firewall.test.js` — Expected: FAIL, cannot find `../lib/firewall`.

- [ ] **Step 3: Implement**

`lib/firewall.js`:
```js
const { log } = require('./logger');

// shortcut: a single flat "vendo5-allow" set/chain, add/remove by MAC; no
// per-interface or per-VLAN scoping. Revisit if sub-project #2's hardware
// testing needs more than one LAN segment gated.
function createFirewall(runCommand) {
  function allow(mac) {
    runCommand(['nft', 'add', 'element', 'inet', 'vendo5', 'allowed', '{', mac, '}']);
  }

  function revoke(mac) {
    runCommand(['nft', 'delete', 'element', 'inet', 'vendo5', 'allowed', '{', mac, '}']);
  }

  function syncFromSessions(sessionsByMac) {
    for (const mac of Object.keys(sessionsByMac)) {
      try {
        allow(mac);
      } catch (e) {
        log('error', `firewall sync failed for mac`, { mac, error: e.message });
      }
    }
  }

  return { allow, revoke, syncFromSessions };
}

module.exports = { createFirewall };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/firewall.test.js` — Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/firewall.js test/firewall.test.js
git commit -m "feat: add firewall gate (allow/revoke/sync by MAC)"
```

---

### Task 3: ARP resolver

**Files:**
- Create: `lib/arp.js`
- Test: `test/arp.test.js`

**Interfaces:**
- Produces: `createArp(runCommand)` → `{ ipToMac(ip) }`. `runCommand(args:
  string[])` returns a string (stdout) here — different return
  convention from `firewall.js`'s void `runCommand`, because this module
  reads rather than writes; tests inject a fake returning fixture text.
  Returns `null` when no ARP/neighbor entry is found for the IP.

- [ ] **Step 1: Write failing test**

`test/arp.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/arp.test.js` — Expected: FAIL, cannot find `../lib/arp`.

- [ ] **Step 3: Implement**

`lib/arp.js`:
```js
function createArp(runCommand) {
  function ipToMac(ip) {
    let out;
    try {
      out = runCommand(['ip', 'neigh', 'show', ip]);
    } catch {
      return null;
    }
    const match = /lladdr\s+([0-9a-f:]{17})/i.exec(out || '');
    return match ? match[1] : null;
  }

  return { ipToMac };
}

module.exports = { createArp };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/arp.test.js` — Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/arp.js test/arp.test.js
git commit -m "feat: add ARP resolver (IP to MAC, null when unresolved)"
```

---

### Task 4: Captive portal HTTP server

**Files:**
- Create: `lib/portal.js`
- Test: `test/portal.test.js`

**Interfaces:**
- Consumes: `session` object with `isActive(mac, now)`, `getSession(mac)`
  shape (Task 1's return from `createSessionStore`); `arp` object with
  `ipToMac(ip)` (Task 3's `createArp` return). Both passed in as
  dependencies, not required/imported directly, so tests inject fakes.
- Produces: `createServer({ session, arp, ratePesosPerMinute, now =
  Date.now })` → a `node:http.Server` (not yet listening — caller calls
  `.listen(port)`). Exposes the pending-payer mechanism internally (not
  part of the public interface beyond the two routes below — Task 5's
  `main.js` reads it via a separate accessor, see Task 5's brief).
- Routes: `POST /api/pay-intent` → `{ ok: true }`, records caller's MAC
  as pending payer (TTL 10s) for `onPulse` (Task 5) to consume. `GET
  /api/status` → `{ active, remainingSeconds }` for caller's MAC. Any
  other path → HTML landing page (200) if unpaid/unresolved MAC, or a
  simple "online" HTML page (200) if the caller's MAC is active.
- To let `main.js` (Task 5) consume the pending payer set by a pulse,
  `createServer` also returns `{ server, consumePendingPayer() }` —
  `consumePendingPayer()` returns the pending MAC and clears it if one
  is set and not TTL-expired, else returns `null`. This is the function
  `onPulse` calls.

- [ ] **Step 1: Write failing test**

`test/portal.test.js`:
```js
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

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}
function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('unpaid client gets the landing page on GET /', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /insert coin/i);
  server.close();
});

test('active client gets an online page on GET /', async () => {
  const { server } = createServer({ session: fakeSession(true), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /online/i);
  server.close();
});

test('unresolved MAC (arp returns null) is treated as unpaid, does not throw', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp(null), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /insert coin/i);
  server.close();
});

test('POST /api/pay-intent records the pending payer, consumePendingPayer returns it once', async () => {
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'POST', '/api/pay-intent');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(consumePendingPayer(), 'm1');
  assert.equal(consumePendingPayer(), null); // consumed, not reusable
  server.close();
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/portal.test.js` — Expected: FAIL, cannot find `../lib/portal`.

- [ ] **Step 3: Implement**

`lib/portal.js`:
```js
const http = require('node:http');

const PAY_INTENT_TTL_MS = 10000;

function createServer({ session, arp, ratePesosPerMinute }) {
  let pendingPayer = null; // { mac, at }

  function consumePendingPayer(now = Date.now()) {
    if (!pendingPayer) return null;
    const { mac, at } = pendingPayer;
    pendingPayer = null;
    return now - at <= PAY_INTENT_TTL_MS ? mac : null;
  }

  function clientMac(req) {
    const ip = req.socket.remoteAddress;
    return arp.ipToMac(ip);
  }

  function landingPage() {
    return '<html><body><h1>Insert coin to continue</h1></body></html>';
  }

  function onlinePage(remainingSeconds) {
    return `<html><body><h1>You're online</h1><p>${remainingSeconds}s remaining</p></body></html>`;
  }

  function remainingSecondsFor(mac, now = Date.now()) {
    const sess = session.getSession(mac);
    if (!sess) return 0;
    return Math.max(0, Math.round((sess.expiresAt - now) / 1000));
  }

  const server = http.createServer((req, res) => {
    const mac = clientMac(req);

    if (req.method === 'POST' && req.url === '/api/pay-intent') {
      if (mac) pendingPayer = { mac, at: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      const active = !!mac && session.isActive(mac);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active, remainingSeconds: active ? remainingSecondsFor(mac) : 0 }));
      return;
    }

    const active = !!mac && session.isActive(mac);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(active ? onlinePage(remainingSecondsFor(mac)) : landingPage());
  });

  return { server, consumePendingPayer };
}

module.exports = { createServer };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/portal.test.js` — Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/portal.js test/portal.test.js
git commit -m "feat: add captive portal HTTP server (landing page, pay-intent, status)"
```

---

### Task 5: Wire into main.js, config, and coin-pulse handling

**Files:**
- Modify: `main.js`, `config/vendo.json`, `lib/config.js:5-8`
  (`REQUIRED.vendo`)
- Test: `test/main.test.js` (extend existing file from sub-project #1)

**Interfaces:**
- Consumes: `createSessionStore` (Task 1), `createFirewall` (Task 2),
  `createArp` (Task 3), `createServer`/`consumePendingPayer` (Task 4),
  `createGpio`/`watchPin` (sub-project #1's `lib/gpio.js`), `loadConfig`
  (sub-project #1's `lib/config.js`, extended here).
- Produces: `main.js` now also listens on port 3000, watches the coin
  pin, and sweeps expiry every second. Env var `VENDO5_SESSION_FILE`
  overrides the session file path (default
  `/mnt/wifi5/vendo5-sessions.json`), matching the `VENDO5_*` env-var
  override pattern `main.js` already uses for config dirs. Env var
  `VENDO5_PORTAL_PORT` overrides the listen port (default 3000) — needed
  so the smoke test doesn't collide with a real port 3000 on the test
  machine. Env var `VENDO5_FIREWALL_CMD` — when set to `"noop"`, swaps in
  a no-op `runCommand` for firewall/arp instead of the real `nft`/`ip`
  shell-outs, so the smoke test (which has no real nft/ip neigh
  environment) can run `main.js` as a real child process without
  requiring root or a real network stack.

- [ ] **Step 1: Write failing test (extends existing main.test.js)**

Add to `test/main.test.js` (keep the existing two tests from sub-project
#1 as-is; this step adds new ones below them in the same file):

```js
test('vendo config missing pricing fields fails startup (extends required-key validation)', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendo.json'), JSON.stringify({ coin_pin: 17 }));
  const r = run({ VENDO5_CONFIG_DIR: dir, VENDO5_DEFAULTS_DIR: DEFAULTS });
  assert.equal(await r.exited, 1);
  assert.match(r.out(), /"level":"error".*vendo\.json/);
});

test('portal listens and serves the landing page; coin pulse with no pay-intent is refused and logged', async () => {
  const configDir = tmpDir();
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5sessfile-')), 'sessions.json');
  const gpioBase = fs.mkdtempSync(path.join(os.tmpdir(), 'v5gpiobase-'));
  fs.writeFileSync(path.join(gpioBase, 'export'), '');
  fs.writeFileSync(path.join(gpioBase, 'unexport'), '');
  const pinDir = path.join(gpioBase, 'gpio17');
  fs.mkdirSync(pinDir, { recursive: true });
  fs.writeFileSync(path.join(pinDir, 'value'), '0');
  fs.writeFileSync(path.join(pinDir, 'direction'), '');
  fs.writeFileSync(path.join(pinDir, 'edge'), '');

  const r = run({
    VENDO5_CONFIG_DIR: configDir,
    VENDO5_DEFAULTS_DIR: DEFAULTS,
    VENDO5_SESSION_FILE: sessionFile,
    VENDO5_GPIO_BASE: gpioBase,
    VENDO5_PORTAL_PORT: '0', // ephemeral; main.js logs the actual bound port
    VENDO5_FIREWALL_CMD: 'noop',
  });
  await new Promise((res) => r.p.stdout.once('data', res));

  // trigger a coin pulse with no pending pay-intent
  fs.writeFileSync(path.join(pinDir, 'value'), '1');
  await new Promise((res) => setTimeout(res, 200));

  r.p.kill('SIGTERM');
  await r.exited;
  assert.match(r.out(), /"level":"warn".*orphan/i);
});
```

(This task's `main.js` must therefore log its bound port, e.g. `log('info',
'portal listening', { port })`, and accept port `0` for an OS-assigned
ephemeral port — avoids the smoke test needing a fixed free port.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/main.test.js` — Expected: FAIL (new env vars not
read yet; vendo.json still only requires `coin_pin`, so the first new
test fails for the wrong reason — missing pricing validation — and the
second fails because nothing listens/watches yet).

- [ ] **Step 3: Implement**

`lib/config.js` — extend `REQUIRED.vendo` (`lib/config.js:5-8`):
```js
const REQUIRED = {
  network: ['lan_interface'],
  vendo: ['coin_pin', 'pulse_value_pesos', 'pesos_per_minute'],
  licensing: ['mode'],
};
```

`config/vendo.json`:
```json
{ "coin_pin": 17, "pulse_value_pesos": 1, "pesos_per_minute": 1 }
```

`main.js` — replace the file:
```js
const { loadConfig } = require('./lib/config');
const { log } = require('./lib/logger');
const { createGpio } = require('./lib/gpio');
const { createSessionStore } = require('./lib/session');
const { createFirewall } = require('./lib/firewall');
const { createArp } = require('./lib/arp');
const { createServer } = require('./lib/portal');
const { version } = require('./package.json');

const configDir = process.env.VENDO5_CONFIG_DIR || '/mnt/wifi5/vendo5-config';
const defaultsDir = process.env.VENDO5_DEFAULTS_DIR || '/opt/vendo5/config';
const sessionFile = process.env.VENDO5_SESSION_FILE || '/mnt/wifi5/vendo5-sessions.json';
const gpioBase = process.env.VENDO5_GPIO_BASE || '/sys/class/gpio';
const portalPort = Number(process.env.VENDO5_PORTAL_PORT || 3000);

let config;
try {
  config = loadConfig(configDir, defaultsDir);
} catch (e) {
  log('error', e.message);
  process.exit(1);
}

const shutdown = () => { log('info', 'vendo5 stopping'); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

log('info', 'vendo5 started', { version, config: Object.keys(config) });

const { coin_pin, pulse_value_pesos, pesos_per_minute } = config.vendo;

const session = createSessionStore(sessionFile);
session.load();

// shortcut: no-op shell-out for firewall/arp when VENDO5_FIREWALL_CMD=noop
// (used by the smoke test, which has no real nft/ip environment). Real
// deployments never set this, so production always shells out for real.
const runCommand = process.env.VENDO5_FIREWALL_CMD === 'noop'
  ? () => ''
  : (args) => {
      const { execFileSync } = require('node:child_process');
      return execFileSync(args[0], args.slice(1), { encoding: 'utf8' });
    };

const firewall = createFirewall(runCommand);
const arp = createArp(runCommand);

try {
  firewall.syncFromSessions(Object.fromEntries(
    Object.keys(config).length ? [] : [] // placeholder replaced below
  ));
} catch (e) {
  log('error', 'firewall sync failed at boot', { error: e.message });
}

const { server, consumePendingPayer } = createServer({ session, arp, ratePesosPerMinute: pesos_per_minute });
server.listen(portalPort, () => {
  log('info', 'portal listening', { port: server.address().port });
});

const gpio = createGpio(gpioBase);
gpio.exportPin(coin_pin);
gpio.watchPin(coin_pin, 'in', 'rising', (value) => {
  if (value !== 1) return;
  const mac = consumePendingPayer();
  if (!mac) {
    log('warn', 'orphan coin pulse: no pending payer', { pin: coin_pin });
    return;
  }
  session.addCredit(mac, pulse_value_pesos, pesos_per_minute);
  try {
    firewall.allow(mac);
  } catch (e) {
    log('error', 'firewall allow failed', { mac, error: e.message });
  }
  session.save();
});

setInterval(() => {
  const due = session.expireDue();
  for (const mac of due) {
    try {
      firewall.revoke(mac);
    } catch (e) {
      log('error', 'firewall revoke failed', { mac, error: e.message });
    }
  }
  if (due.length) session.save();
}, 1000);
```

Note: `syncFromSessions` needs the actual loaded sessions, not the
placeholder above — `session.js` (Task 1) exposes state only through
`getSession`/`isActive`/`expireDue`, not a full-map getter. Add one more
tiny accessor to close this gap cleanly:

- [ ] **Step 3b: Add `all()` to lib/session.js and its test**

In `test/session.test.js`, add:
```js
test('all() returns every active session keyed by mac', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('m1', 1, 1, 0);
  s.addCredit('m2', 1, 1, 0);
  const snapshot = s.all();
  assert.deepEqual(Object.keys(snapshot).sort(), ['m1', 'm2']);
});
```

In `lib/session.js`, add to the returned object:
```js
  function all() {
    return { ...sessions };
  }
```
and include `all` in the final `return { load, save, addCredit, getSession, isActive, expireDue, all };`.

Then in `main.js`, replace the placeholder sync call with:
```js
try {
  firewall.syncFromSessions(session.all());
} catch (e) {
  log('error', 'firewall sync failed at boot', { error: e.message });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test` — Expected: all tests across every file pass
(session: 10, firewall: 7, arp: 4, portal: 7, main: 4, plus sub-project
#1's logger/config/gpio tests still green — full count printed by the
runner).

- [ ] **Step 5: Commit**

```bash
git add main.js config/vendo.json lib/config.js lib/session.js test/main.test.js test/session.test.js
git commit -m "feat: wire session/firewall/arp/portal into main.js; coin pulse -> credit -> allow"
```

---

## Self-Review

- **Spec coverage:** session top-up/expiry/persistence (Task 1), firewall
  allow/revoke/sync (Task 2), ARP MAC resolution with null-safety (Task
  3), portal landing/status/pay-intent (Task 4), full wiring including
  orphan-pulse refusal, boot-time sync, and expiry sweep (Task 5). Out-of
  scope items (licensing, cloud, eLoad, PPPoE) are untouched — confirmed
  no task introduces them.
- **Review Focus coverage:** rapid-pulse top-up is Task 1's "extends,
  does not queue" test; MAC-not-IP keying is implicit in every
  `firewall`/`session` test using MAC as the sole key (no IP parameter
  exists anywhere in those interfaces, so there's nothing to key on but
  MAC — structurally enforced, not just tested) — added explicit note:
  Task 4's portal resolves IP→MAC once per request via `arp`, so an IP
  change just re-resolves to the same MAC next request, no stale
  IP-keyed state anywhere; race between expiry sweep and in-flight
  top-up is inherent to `addCredit`'s "existing && not yet expired"
  check happening before `expireDue` can remove it in the same tick —
  Node's single-threaded event loop means these never interleave
  mid-check, so no additional test is needed beyond Task 1's existing
  ones, noted here rather than adding a redundant test; disk session
  already past expiry at boot is Task 1's "load drops already-expired"
  test; unresolved-MAC request is Task 4's "unresolved MAC... does not
  throw" test.
- **Type/interface consistency:** `session.js`'s `addCredit(mac, pesos,
  ratePesosPerMinute, now)` signature matches every caller (`main.js`
  Task 5, tests). `firewall.js`'s `runCommand(args) -> void/throws` vs
  `arp.js`'s `runCommand(args) -> string` are deliberately different
  contracts for different purposes — noted explicitly in each task's
  Interfaces block so neither is mistaken for the other. `portal.js`'s
  `createServer` return shape `{ server, consumePendingPayer }` is used
  identically in its own tests and in Task 5's `main.js`.
