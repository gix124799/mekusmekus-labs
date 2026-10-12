# MAC Randomization (Resume Code + Trial Cap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer whose phone changes MAC gets their time back by typing a resume code (or their used voucher code) in the voucher box; free trials are capped per hour vendo-wide.

**Architecture:** The session store gives every fresh session a `resumeCode` and can `findByCode` and `move` a session between MACs. `money.redeemVoucher` falls back to a move when the code is not a voucher or credit code. The portal shows the code on the Logs page and in the `code` field. `portal-ops.trial` keeps an in-memory list of trial times.

**Tech Stack:** Node.js (CommonJS), `node:test`, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-10-12-mac-randomization-design.md`

## Global Constraints

- No portal UI changes; no new dependencies.
- Code alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, length 8, `crypto.randomInt`.
- Wallet credit and points are not moved.
- `trial_max_per_hour` default 10, from `vendo.json`.
- `npm test` green at the end of each task (baseline 375 pass).

## Review Focus

- Sessions saved before this change (no `resumeCode`) must get one on load, or their owners have no code. -> Task 1 test.
- A paused or outage-frozen session moved to a new MAC must not be let through the firewall. -> Task 2 test.
- Entering your own running code on the same device must not break or duplicate the session. -> Task 2 test.
- A customer-disconnected session moved to a new MAC stays disconnected (no allow). -> Task 2 test.
- An expired session's code must not move anything. -> Task 1 test.

---

### Task 1: Session store — resume code, findByCode, move

**Files:**
- Modify: `lib/session.js`
- Test: `test/session.test.js` (append)

**Interfaces:**
- Produces: `session.resumeCode` (string, 8 chars) on every fresh session; `sessions.findByCode(code, now)` -> MAC string or `null` (live sessions only, matches `resumeCode` or voucher `code`); `sessions.move(fromMac, toMac, now)` -> `true` / `false` (false when `from` is not live or `to` is live).

- [ ] **Step 1: Failing tests** (append to `test/session.test.js`)

```js
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

test('every fresh session gets a resume code; topping up keeps it', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('m1', 1, 1, 0);
  const code = s.getSession('m1').resumeCode;
  assert.match(code, CODE);
  s.addCredit('m1', 1, 1, 1000);
  assert.equal(s.getSession('m1').resumeCode, code);
  s.addTime('m2', 60000, { code: 'VOUCH1' }, 0);
  assert.match(s.getSession('m2').resumeCode, CODE);
  assert.notEqual(s.getSession('m2').resumeCode, code);
});

test('sessions saved before resume codes existed get one on load', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ m1: { mac: 'm1', creditPesos: 1, expiresAt: 9e15, startedAt: 0 } }));
  const s = createSessionStore(f);
  s.load(1000);
  assert.match(s.getSession('m1').resumeCode, CODE);
});

test('findByCode finds a live session by resume code or voucher code, not an expired one', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addTime('m1', 60000, { code: 'VOUCH1' }, 0);
  const rc = s.getSession('m1').resumeCode;
  assert.equal(s.findByCode(rc, 1000), 'm1');
  assert.equal(s.findByCode('VOUCH1', 1000), 'm1');
  assert.equal(s.findByCode('NOPE2345', 1000), null);
  assert.equal(s.findByCode(rc, 61000), null, 'expired');
});

test('move carries the whole session to the new MAC', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addTime('old', 60000, { upload: '1M' }, 0);
  s.pause('old', 10000, { force: true });
  const before = s.getSession('old');
  assert.equal(s.move('old', 'new', 20000), true);
  assert.equal(s.getSession('old'), undefined);
  const now = s.getSession('new');
  assert.equal(now.mac, 'new');
  assert.equal(now.remainingMs, 50000);
  assert.equal(now.paused, true);
  assert.equal(now.upload, '1M');
  assert.equal(now.resumeCode, before.resumeCode);
});

test('move refuses when the source is not live or the target already has time', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  assert.equal(s.move('ghost', 'new', 0), false);
  s.addTime('a', 60000, {}, 0);
  s.addTime('b', 60000, {}, 0);
  assert.equal(s.move('a', 'b', 1000), false);
  assert.equal(s.move('a', 'a', 1000), false);
  assert.equal(s.move('a', 'c', 61000), false, 'expired');
});
```

- [ ] **Step 2: Run** `node --test test/session.test.js` — Expected: the 5 new tests FAIL (`resumeCode` undefined / `findByCode is not a function`).

- [ ] **Step 3: Implement in `lib/session.js`**

At the top:

```js
const crypto = require('node:crypto');

// A code the customer can type on a phone that changed its MAC: no 0/O/1/I to misread.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
```

In `load`, replace `if (live(sess, now)) sessions[mac] = sess;` with:

```js
      if (!live(sess, now)) continue;
      if (!sess.resumeCode) sess.resumeCode = newCode(); // saved before resume codes existed
      sessions[mac] = sess;
```

In `addCredit`, the fresh branch becomes:

```js
      sessions[mac] = { mac, creditPesos: pesos, expiresAt: now + minutes * 60000, startedAt: now, resumeCode: newCode() };
```

In `addTime`, the fresh object becomes:

```js
    const s = fresh ? { mac, creditPesos: 0, expiresAt: now, startedAt: now, type: meta.type || 'consumable', resumeCode: newCode() } : cur;
```

Add before `restore`:

```js
  // The live session a resume code (or the voucher code it runs) belongs to.
  function findByCode(code, now = Date.now()) {
    for (const [mac, s] of Object.entries(sessions)) {
      if (live(s, now) && (s.resumeCode === code || s.code === code)) return mac;
    }
    return null;
  }

  // A phone that came back with a new MAC: the whole session goes with it.
  function move(from, to, now = Date.now()) {
    const s = sessions[from];
    if (from === to || !s || !live(s, now)) return false;
    if (sessions[to] && live(sessions[to], now)) return false;
    sessions[to] = { ...s, mac: to };
    delete sessions[from];
    return true;
  }
```

Export list: add `findByCode, move`.

- [ ] **Step 4: Run** `node --test test/session.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/session.js test/session.test.js && git commit -m "Session: resume code on every session, findByCode, move to a new MAC"`

---

### Task 2: Money — the voucher box moves a session by resume code

**Files:**
- Modify: `lib/money/redeem.js` (redeemVoucher + new moveSession)
- Test: `test/money.test.js` (append)

**Interfaces:**
- Consumes: `sessions.findByCode`, `sessions.move` (Task 1).
- Produces: `money.redeemVoucher(mac, code)` also returns `{ ok: true, message: 'Success' }` for a successful move; refusals `This device already has time`, `This code is already running on this device`, `Could not connect you, try again`.

- [ ] **Step 1: Failing tests** (append to `test/money.test.js`)

```js
test('a resume code moves the time to the new MAC: old revoked, new allowed, logged', () => {
  const r = rig();
  r.money.redeemVoucher('aa:aa:aa:aa:aa:01', r.make().code);
  const code = r.sessions.getSession('aa:aa:aa:aa:aa:01').resumeCode;
  r.tick(60000);
  r.calls.length = 0;
  assert.deepEqual(r.money.redeemVoucher('aa:aa:aa:aa:aa:02', code.toLowerCase()), { ok: true, message: 'Success' });
  assert.equal(r.sessions.getSession('aa:aa:aa:aa:aa:01'), undefined);
  assert.equal(r.sessions.getSession('aa:aa:aa:aa:aa:02').expiresAt, r.now() + 540000);
  assert.deepEqual(r.calls.filter((c) => c[0] !== 'save'), [['allow', 'aa:aa:aa:aa:aa:02'], ['revoke', 'aa:aa:aa:aa:aa:01']]);
  assert.ok(r.lines.some((l) => /Session moved from aa:aa:aa:aa:aa:01 to aa:aa:aa:aa:aa:02/.test(l)));
});

test('the used voucher code also brings the session along', () => {
  const r = rig();
  const v = r.make();
  r.money.redeemVoucher('m1', v.code);
  assert.equal(r.money.redeemVoucher('m2', v.code).ok, true);
  assert.ok(r.sessions.getSession('m2'));
});

test('a move is refused when the new device already has time, or it is the same device', () => {
  const r = rig();
  r.money.redeemVoucher('m1', r.make().code);
  r.money.redeemVoucher('m2', r.make().code);
  const code = r.sessions.getSession('m1').resumeCode;
  assert.equal(r.money.redeemVoucher('m2', code).message, 'This device already has time');
  assert.equal(r.money.redeemVoucher('m1', code).message, 'This code is already running on this device');
  assert.ok(r.sessions.getSession('m1'));
});

test('a paused or disconnected session moves without being let through', () => {
  const r = rig();
  r.money.redeemVoucher('m1', r.make().code);
  r.money.adminPause('m1');
  r.calls.length = 0;
  assert.equal(r.money.redeemVoucher('m2', r.sessions.getSession('m1').resumeCode).ok, true);
  assert.equal(r.calls.filter((c) => c[0] === 'allow').length, 0);
  assert.equal(r.sessions.getSession('m2').paused, true);
  r.money.redeemVoucher('m3', r.make().code);
  r.sessions.getSession('m3').disconnected = true;
  r.calls.length = 0;
  assert.equal(r.money.redeemVoucher('m4', r.sessions.getSession('m3').resumeCode).ok, true);
  assert.equal(r.calls.filter((c) => c[0] === 'allow').length, 0);
});

test('if the new MAC cannot be allowed, the session stays on the old one', () => {
  const r = rig();
  r.money.redeemVoucher('m1', r.make().code);
  const code = r.sessions.getSession('m1').resumeCode;
  const bad = rig({ allowThrows: true });
  bad.sessions.addTime('m1', 60000, {}, bad.now());
  const code2 = bad.sessions.getSession('m1').resumeCode;
  assert.equal(bad.money.redeemVoucher('m2', code2).message, 'Could not connect you, try again');
  assert.ok(bad.sessions.getSession('m1'));
  assert.equal(bad.sessions.getSession('m2'), undefined);
  assert.ok(code);
});
```

- [ ] **Step 2: Run** `node --test test/money.test.js` — Expected: the 5 new tests FAIL (`Invalid voucher`).

- [ ] **Step 3: Implement in `lib/money/redeem.js`**

In `redeemVoucher`, directly before `if (!v) {` (the miss/log block) insert:

```js
    if (!v && wellFormed) { const moved = moveSession(mac, code); if (moved) return moved; }
```

Add after `redeemCredit`:

```js
  // A phone that changed its MAC (random MAC): its resume code, or the voucher code it ran, takes the time along.
  // null when the code belongs to no live session (then it is just a wrong code).
  function moveSession(mac, code) {
    const t = now();
    const from = sessions.findByCode(code, t);
    if (!from) return null;
    if (from === mac) return { ok: false, message: 'This code is already running on this device' };
    if (!sessions.move(from, mac, t)) return { ok: false, message: 'This device already has time' };
    const s = sessions.getSession(mac);
    if (!s.paused && !s.disconnected) {
      try {
        firewall.allow(mac);
      } catch (e) {
        sessions.move(mac, from, t);
        log(`Firewall refused ${mac}: ${e.message}`);
        return { ok: false, message: 'Could not connect you, try again' };
      }
    }
    try { firewall.revoke(from); } catch { /* not in the allowed set */ }
    save();
    log(`Session moved from ${from} to ${mac} (resume code)`);
    clog(mac, `Session moved here from ${from}`);
    wrong.delete(mac);
    return { ok: true, message: 'Success' };
  }
```

- [ ] **Step 4: Run** `node --test test/money.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/money/redeem.js test/money.test.js && git commit -m "Voucher box: a resume code or used voucher code moves the session to a phone's new MAC"`

---

### Task 3: Portal shows the resume code

**Files:**
- Modify: `lib/wire/portal.js` (`info` code field, `K(0)`)
- Create: `test/wire-portal.test.js`

**Interfaces:**
- Consumes: `session.resumeCode` (Task 1).

- [ ] **Step 1: Failing test** (`test/wire-portal.test.js`)

```js
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
```

- [ ] **Step 2: Run** `node --test test/wire-portal.test.js` — Expected: FAIL (no resume code in logs; code field empty).

- [ ] **Step 3: Implement in `lib/wire/portal.js`**

In `info`, change `code: (s && s.code) || ''` to `code: (s && (s.code || s.resumeCode)) || ''`.

Replace the `[K(0)]` line with:

```js
    // Logs page; while the device has time it ends with the code that takes the time to a new MAC.
    [K(0)]: guarded('', (_p, ctx) => {
      if (!ctx.mac) return '';
      const logs = clientLog.read(ctx.mac).data;
      const s = sessions.getSession(ctx.mac);
      const live = !!s && (s.paused || s.expiresAt > now());
      return live && s.resumeCode ? `${logs}Resume code: ${s.resumeCode} - if your phone changes its MAC, enter this code in the voucher box to get your time back\n` : logs;
    }),
```

- [ ] **Step 4: Run** `node --test test/wire-portal.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/wire/portal.js test/wire-portal.test.js && git commit -m "Portal: show the resume code on the Logs page and in the code field"`

---

### Task 4: Vendo-wide free-trial cap

**Files:**
- Modify: `lib/money/portal-ops.js` (deps + `trial`), `main.js` (`createPortalOps` call), `config/vendo.json`
- Create: `test/portal-ops.test.js`

- [ ] **Step 1: Failing test** (`test/portal-ops.test.js`)

```js
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
```

- [ ] **Step 2: Run** `node --test test/portal-ops.test.js` — Expected: first test FAILS (third trial says `Connected`).

- [ ] **Step 3: Implement**

`lib/money/portal-ops.js`: add `trialMaxPerHour = Infinity` to the destructured deps, and `const trials = []; // times of the trials given in the last hour (all devices)` before `return {`. In `trial`, after the `if (!(ms > 0)) ...` line:

```js
      // Random MACs make the per-device trial flag easy to dodge, so the vendo as a whole has an hourly limit.
      // shortcut: counted in memory, a restart resets it; persist it if owners see abuse around reboots.
      while (trials.length && now() - trials[0] >= 3600000) trials.shift();
      if (trials.length >= trialMaxPerHour) return 'Free trial limit reached, try again later';
```

and after `clients.markTrial(mac);`:

```js
      trials.push(now());
```

`main.js` `createPortalOps({ ... })`: add `trialMaxPerHour: Number(config.vendo.trial_max_per_hour ?? 10),`.

`config/vendo.json`: add `"trial_max_per_hour": 10`.

- [ ] **Step 4: Run** `node --test test/portal-ops.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/money/portal-ops.js main.js config/vendo.json test/portal-ops.test.js && git commit -m "Free trial: vendo-wide hourly cap (random MACs dodge the per-device flag)"`
