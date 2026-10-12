# Admin Pause + Network Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin dashboard can pause/resume any client, and a watchdog freezes client time while the internet is down and tries to bring WAN/LAN back.

**Architecture:** Session store gets a forced pause plus `freeze`/`thaw` (outage = a pause marked `outage: true`). `money.adminPause` and `@nav-22313` expose the admin toggle. A new `lib/system/watchdog.js` pings with async `execFile`, calls freeze/thaw, runs `ifup`, and writes bell notifications; `main.js` ticks it every 30 s.

**Tech Stack:** Node.js (CommonJS), `node:test`, OpenWrt (procd, `ifup`, busybox `ping`).

**Spec:** `docs/superpowers/specs/2026-10-12-admin-pause-and-watchdog-design.md`

## Global Constraints

- No new dependencies.
- Watchdog commands never use the sync `runCommand`; only async `execFile` (coin pulses must not be delayed).
- Admin pause never spends the customer's `pauselimit`.
- No automatic device reboot on WAN loss.
- Run the whole suite with `npm test` (baseline: 347 pass, 0 fail).

## Review Focus

- WAN flapping (fail, ok, fail, ok...) must never freeze anyone: only 3 *consecutive* failures count. -> Task 3 test.
- A tick still running when the next interval fires (slow pings) must not run twice in parallel. -> Task 3 test.
- `notifications.add` throwing (disk full) must not stop freeze/thaw. -> Task 3 test.
- Coins or a voucher added to an outage-frozen session must add to `remainingMs`, and thaw must return all of it. -> Task 1 test.
- A customer pause that existed before the outage must still be paused after thaw. -> Task 1 test.

---

### Task 1: Session store — forced pause, freeze, thaw

**Files:**
- Modify: `lib/session.js` (pause, resume, new freeze/thaw, export list)
- Test: `test/session.test.js` (append)

**Interfaces:**
- Produces: `sessions.pause(mac, now, { force })` -> `{ ok, reason?, session? }`; `sessions.freeze(now)` -> `string[]` MACs frozen; `sessions.thaw(now)` -> `string[]` MACs resumed.

- [ ] **Step 1: Write the failing tests** (append to `test/session.test.js`)

```js
test('forced pause works on a consumable session and does not spend pauselimit', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addTime('m1', 60000, { type: 'consumable' }, 1000);
  assert.equal(s.pause('m1', 2000).ok, false, 'a customer cannot pause a consumable session');
  assert.equal(s.pause('m1', 2000, { force: true }).ok, true);
  assert.equal(s.getSession('m1').remainingMs, 59000);
  s.resume('m1', 5000);
  s.addTime('m2', 60000, { type: 'pausable', pauselimit: 1 }, 1000);
  s.pause('m2', 2000, { force: true });
  assert.equal(s.getSession('m2').pauselimit, 1);
});

test('freeze stops the clock of running sessions; thaw resumes only those', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addTime('run', 60000, {}, 0);
  s.addTime('mine', 60000, { type: 'pausable' }, 0);
  s.pause('mine', 10000); // customer pause before the outage: 50000 left
  assert.deepEqual(s.freeze(20000), ['run']);
  assert.deepEqual(s.freeze(21000), [], 'freezing twice changes nothing');
  assert.deepEqual(s.expireDue(500000), [], 'nobody runs out during an outage');
  s.addCredit('run', 1, 1, 30000); // a coin during the outage: +60000
  assert.deepEqual(s.thaw(600000), ['run']);
  assert.equal(s.getSession('run').expiresAt, 600000 + 40000 + 60000);
  assert.equal(s.getSession('run').outage, undefined);
  assert.equal(s.getSession('mine').paused, true, 'a customer pause stays paused');
  assert.equal(s.getSession('mine').remainingMs, 50000);
  assert.deepEqual(s.thaw(700000), [], 'thaw with nothing frozen is a no-op');
});

test('a customer resume during the outage clears the outage mark', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addTime('m1', 60000, {}, 0);
  s.freeze(10000);
  assert.equal(s.resume('m1', 20000).ok, true);
  assert.equal(s.getSession('m1').outage, undefined);
  assert.deepEqual(s.thaw(30000), []);
});

test('frozen sessions survive a save and load', () => {
  const f = tmpFile();
  const a = createSessionStore(f);
  a.load();
  a.addTime('m1', 60000, {}, 0);
  a.freeze(10000);
  a.save();
  const b = createSessionStore(f);
  b.load(999999999);
  assert.deepEqual(b.thaw(1000000), ['m1']);
  assert.equal(b.getSession('m1').expiresAt, 1000000 + 50000);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/session.test.js`
Expected: FAIL (`s.freeze is not a function`, forced pause returns `ok: false`).

- [ ] **Step 3: Implement in `lib/session.js`**

Replace `pause` and `resume` with:

```js
  // Pause freezes the remaining time; only a pausable session with pauses left can pause.
  // force (admin): any live session, and no pause is spent.
  function pause(mac, now = Date.now(), { force = false } = {}) {
    const s = sessions[mac];
    if (!s || !live(s, now) || s.paused) return { ok: false, reason: 'No active session' };
    if (!force && s.type !== 'pausable') return { ok: false, reason: 'This session cannot be paused' };
    if (!force && s.pauselimit !== undefined && s.pauselimit <= 0) return { ok: false, reason: 'No pauses left' };
    s.remainingMs = Math.max(0, s.expiresAt - now);
    s.paused = true;
    if (!force && s.pauselimit !== undefined) s.pauselimit -= 1;
    return { ok: true, session: s };
  }

  function resume(mac, now = Date.now()) {
    const s = sessions[mac];
    if (!s || !s.paused || !live(s, now)) return { ok: false, reason: 'Not paused' };
    s.expiresAt = now + s.remainingMs;
    delete s.paused;
    delete s.remainingMs;
    delete s.outage;
    return { ok: true, session: s };
  }

  // Internet outage: every running session stops its clock like a pause, marked so thaw resumes only these.
  function freeze(now = Date.now()) {
    const macs = [];
    for (const [mac, s] of Object.entries(sessions)) {
      if (s.paused || !live(s, now)) continue;
      s.remainingMs = Math.max(0, s.expiresAt - now);
      s.paused = true;
      s.outage = true;
      macs.push(mac);
    }
    return macs;
  }

  function thaw(now = Date.now()) {
    const macs = [];
    for (const [mac, s] of Object.entries(sessions)) {
      if (!s.outage) continue;
      s.expiresAt = now + s.remainingMs;
      delete s.paused;
      delete s.remainingMs;
      delete s.outage;
      macs.push(mac);
    }
    return macs;
  }
```

Export list becomes:

```js
  return { load, save, addCredit, addTime, pause, resume, freeze, thaw, restore, extend, getSession, isActive, expireDue, revoke, all };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/session.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/session.js test/session.test.js
git commit -m "Session: admin-forced pause, freeze/thaw for internet outages"
```

---

### Task 2: Admin pause/resume (`money.adminPause`, `@nav-22313`)

**Files:**
- Modify: `lib/money/redeem.js:100-115` (pause takes opts, add adminPause, export)
- Modify: `lib/wire/nav.js:8` (take `money`), `lib/wire/nav.js:92-93` (the handler)
- Modify: `main.js` createNavHandlers call (pass `money`)
- Test: `test/money.test.js` (append), `test/wire-nav.test.js` (setup + replace the "disconnect is unavailable" test)

**Interfaces:**
- Consumes: `sessions.pause(mac, now, { force })` (Task 1).
- Produces: `money.adminPause(mac)` -> `{ ok, message }`; `createNavHandlers({ ..., money })`.

- [ ] **Step 1: Write the failing tests**

Append to `test/money.test.js`:

```js
test('adminPause pauses a consumable session without spending pauses; resume undoes it', () => {
  const r = rig();
  r.money.redeemVoucher('m1', r.make().code);
  assert.deepEqual(r.money.adminPause('m1'), { ok: true, message: 'Paused' });
  assert.equal(r.sessions.getSession('m1').paused, true);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'revoke'), [['revoke', 'm1']]);
  assert.equal(r.money.resume('m1').ok, true);
  const bad = rig({ revokeThrows: true });
  bad.money.redeemVoucher('m1', bad.make().code);
  assert.equal(bad.money.adminPause('m1').ok, false);
  assert.equal(bad.sessions.getSession('m1').paused, undefined, 'a failed revoke leaves the session running');
});
```

In `test/wire-nav.test.js` add at the top `const { createMoney } = require('../lib/money/redeem');`, and in `setup()` change the firewall line and add `money` to the `createNavHandlers` call:

```js
  const allowed = [];
  const firewall = { revoke: (m) => { if (over.revokeThrows) throw new Error('not in set'); revoked.push(m); }, allow: (m) => allowed.push(m) };
  const nav = createNavHandlers({
    sessions,
    firewall,
    money: createMoney({ sessions, firewall, mainlog: { write: () => {} }, now: () => 100000 }),
```

and return `allowed` too: `return { nav, sessions, lines, revoked, allowed, saved, state };`

Replace the test `'disconnect is unavailable, and says so rather than ending the session'` with:

```js
test('pause button: pauses any running session, resumes a paused one', () => {
  const t = setup();
  t.sessions.addCredit('m1', 1, 1, 50000);
  assert.equal(call(t.nav, '@nav-22313', { mac: 'm1' }), 'Success');
  assert.equal(t.sessions.getSession('m1').paused, true);
  assert.deepEqual(t.revoked, ['m1']);
  assert.equal(call(t.nav, '@nav-22313', { mac: 'm1' }), 'Success');
  assert.equal(t.sessions.getSession('m1').paused, undefined);
  assert.deepEqual(t.allowed, ['m1']);
  assert.ok(t.lines.some((l) => l === 'system|Admin paused m1'));
  assert.ok(t.lines.some((l) => l === 'system|Admin resumed m1'));
  for (const bad of [{ mac: 'nobody' }, null, 3, {}]) assert.equal(call(t.nav, '@nav-22313', bad), 'Error', JSON.stringify(bad));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/money.test.js test/wire-nav.test.js`
Expected: FAIL (`r.money.adminPause is not a function`; `@nav-22313` returns `'Error'`).

- [ ] **Step 3: Implement**

`lib/money/redeem.js`: change the `pause` signature and the `sessions.pause` call, add `adminPause`, export it:

```js
  function pause(mac, opts) {
    if (!mac) return { ok: false, message: 'Device not recognised' };
    const before = sessions.getSession(mac) ? structuredClone(sessions.getSession(mac)) : null;
    const r = sessions.pause(mac, now(), opts);
```
(rest of `pause` unchanged), then after `resume`:

```js
  // Admin dashboard pause: any running session, no pause spent.
  const adminPause = (mac) => pause(mac, { force: true });
```

and `return { redeemVoucher, pause, adminPause, resume, endSession, createSession, blocked };`

Note: `lib/wire/portal.js` and `lib/portal.js` call `money.pause(mac)` with one argument; `opts` is then `undefined` and `sessions.pause` falls back to its `{ force: false }` default, so customers are unaffected.

`lib/wire/nav.js` line 8: add `money` to the destructured deps:

```js
function createNavHandlers({ pppoe, sessions, firewall, money, arp, stats, passthrough, mainlog, notifications, licence, account, reset, now = Date.now, save = () => {} }) {
```

Replace lines 92-93 with:

```js
    // Pause / resume a client from the dashboard (admin override: any session, no pause spent).
    '@nav-22313': guarded('Error', (payload) => {
      const mac = resolveMac(payload);
      const s = typeof mac === 'string' && sessions.getSession(mac);
      if (!s || !money) return 'Error';
      const wasPaused = !!s.paused;
      const r = wasPaused ? money.resume(mac) : money.adminPause(mac);
      if (!r.ok) return 'Error';
      log(`Admin ${wasPaused ? 'resumed' : 'paused'} ${mac}`);
      return 'Success';
    }),
```

`main.js`, in the `createNavHandlers({ ... })` call, add after `firewall,`:

```js
      money,
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/money.test.js test/wire-nav.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/money/redeem.js lib/wire/nav.js main.js test/money.test.js test/wire-nav.test.js
git commit -m "Admin dashboard pause/resume any client (no customer pause spent)"
```

---

### Task 3: Watchdog module

**Files:**
- Create: `lib/system/watchdog.js`
- Test: `test/watchdog.test.js`

**Interfaces:**
- Consumes: `sessions.freeze(now)`, `sessions.thaw(now)` (Task 1); `firewall.allow(mac)`; `notifications.add({ title, icon, message })`; `mainlog.write(category, text)`.
- Produces: `createWatchdog({ exec, linkExists, sessions, firewall, notifications, mainlog, save, now })` -> `{ tick(): Promise<void>, status(): { wanUp, lastOkAt, outageSince, recoveries } }`. `exec(argv)` returns a Promise that rejects when the command fails.

- [ ] **Step 1: Write the failing tests** (`test/watchdog.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const { createWatchdog } = require('../lib/system/watchdog');

function rig({ online = true, lan = true, notifyThrows = false } = {}) {
  const st = { online, lan, t: 1000000, ran: [], notes: [], lines: [], allowed: [], frozen: 0, thawMacs: [], saves: 0 };
  const sessions = {
    freeze: () => { st.frozen++; return ['m1', 'm2']; },
    thaw: () => { const m = st.thawMacs; st.thawMacs = []; return m; },
  };
  const wd = createWatchdog({
    exec: async (argv) => {
      st.ran.push(argv.join(' '));
      if (argv[0] === 'ping' && !st.online) throw new Error('100% packet loss');
      return '';
    },
    linkExists: () => st.lan,
    sessions,
    firewall: { allow: (m) => st.allowed.push(m) },
    notifications: { add: (n) => { if (notifyThrows) throw new Error('disk full'); st.notes.push(n.title); } },
    mainlog: { write: (c, x) => st.lines.push(x) },
    save: () => { st.saves++; },
    now: () => st.t,
  });
  const tick = async (ms = 30000) => { st.t += ms; await wd.tick(); };
  return { wd, st, tick };
}
const ifups = (st, i) => st.ran.filter((r) => r === `ifup ${i}`).length;

test('online: pings only, nothing frozen', async () => {
  const { st, tick, wd } = rig();
  await tick();
  assert.deepEqual(st.ran, ['ping -c 1 -W 2 1.1.1.1']);
  assert.equal(st.frozen, 0);
  assert.equal(wd.status().wanUp, true);
});

test('3 failed ticks in a row freeze time and restart wan; recovery thaws, re-allows and notifies', async () => {
  const { st, tick, wd } = rig({ online: false });
  await tick(); await tick();
  assert.equal(st.frozen, 0, 'two failures are not an outage yet');
  await tick();
  assert.equal(st.frozen, 1);
  assert.equal(ifups(st, 'wan'), 1);
  assert.ok(st.saves >= 1);
  assert.equal(wd.status().wanUp, false);
  await tick(); // still down, under 10 min: no new ifup
  assert.equal(ifups(st, 'wan'), 1);
  st.online = true;
  st.thawMacs = ['m1', 'm2'];
  await tick();
  assert.deepEqual(st.allowed, ['m1', 'm2']);
  assert.deepEqual(st.notes, ['Internet back']);
  assert.equal(wd.status().recoveries, 1);
  assert.equal(wd.status().outageSince, null);
});

test('a long outage retries wan every 10 min and notifies once', async () => {
  const { st, tick } = rig({ online: false });
  await tick(); await tick(); await tick();
  for (let i = 0; i < 20; i++) await tick(60000); // 20 more minutes
  assert.equal(ifups(st, 'wan'), 3);
  assert.deepEqual(st.notes, ['Internet down']);
});

test('flapping WAN never freezes anyone', async () => {
  const { st, tick } = rig();
  for (let i = 0; i < 10; i++) { st.online = i % 2 === 0; await tick(); }
  assert.equal(st.frozen, 0);
});

test('first good ping after a restart thaws sessions left frozen on disk', async () => {
  const { st, tick } = rig();
  st.thawMacs = ['m9'];
  await tick();
  assert.deepEqual(st.allowed, ['m9']);
  assert.deepEqual(st.notes, [], 'no outage seen by this run, so no notification');
  assert.ok(st.lines.some((l) => /restart/.test(l)));
});

test('br-lan missing: netdetect then ifup lan, notify once, retry after 5 min', async () => {
  const { st, tick } = rig({ lan: false });
  await tick();
  assert.deepEqual(st.ran.slice(0, 2), ['/etc/vendo5-netdetect.sh', 'ifup lan']);
  await tick(); // 30 s later: no retry yet
  assert.equal(ifups(st, 'lan'), 1);
  await tick(5 * 60000);
  assert.equal(ifups(st, 'lan'), 2);
  assert.deepEqual(st.notes, ['LAN adapter missing']);
  st.lan = true;
  await tick();
  assert.ok(st.lines.some((l) => /LAN is back/.test(l)));
});

test('overlapping ticks do not run twice', async () => {
  const { st, wd } = rig();
  await Promise.all([wd.tick(), wd.tick()]);
  assert.equal(st.ran.length, 1);
});

test('a failing notification store does not stop freeze or thaw', async () => {
  const { st, tick } = rig({ online: false, notifyThrows: true });
  await tick(); await tick(); await tick();
  st.online = true;
  st.thawMacs = ['m1'];
  await tick();
  assert.equal(st.frozen, 1);
  assert.deepEqual(st.allowed, ['m1']);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/watchdog.test.js`
Expected: FAIL (`Cannot find module '../lib/system/watchdog'`).

- [ ] **Step 3: Implement `lib/system/watchdog.js`**

```js
// Internet and LAN watchdog, ticked every 30 s by main.js. While the internet is down, client time is frozen
// (sessions.freeze) and given back when it returns (sessions.thaw). Commands are async: a blocked event loop
// would delay coin-pulse reads. App crashes (procd respawn) and kernel hangs (hardware watchdog) are not
// handled here.
const WAN_HOSTS = ['1.1.1.1', '8.8.8.8'];
const FAILS_TO_DOWN = 3;
const WAN_RETRY_MS = 10 * 60000;
const LAN_RETRY_MS = 5 * 60000;

function createWatchdog({ exec, linkExists, sessions, firewall, notifications, mainlog, save = () => {}, now = Date.now }) {
  let fails = 0;
  let outageSince = null;
  let lastWanTry = 0;
  let notifiedDown = false;
  let lastOkAt = null;
  let recoveries = 0;
  let lanMissing = false;
  let lastLanTry = 0;
  let busy = false;

  const log = (text) => mainlog.write('system', text);
  const notify = (title, message) => {
    try { notifications.add({ title, icon: 'mdi-wifi-alert', message }); } catch (e) { log(`Watchdog notification failed: ${e.message}`); }
  };
  const run = (argv) => exec(argv).then(() => true, (e) => { log(`Watchdog: ${argv.join(' ')} failed: ${e.message}`); return false; });
  const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

  async function online() {
    for (const host of WAN_HOSTS) {
      try { await exec(['ping', '-c', '1', '-W', '2', host]); return true; } catch { /* try the next host */ }
    }
    return false;
  }

  async function checkLan() {
    const t = now();
    if (linkExists('br-lan')) {
      if (lanMissing) log('Watchdog: LAN is back');
      lanMissing = false;
      return;
    }
    if (!lanMissing) {
      lanMissing = true;
      lastLanTry = 0;
      log('Watchdog: br-lan is missing, re-detecting ports');
      notify('LAN adapter missing', 'br-lan is gone: check the USB LAN adapter');
    }
    if (t - lastLanTry < LAN_RETRY_MS) return;
    lastLanTry = t;
    await run(['/etc/vendo5-netdetect.sh']);
    await run(['ifup', 'lan']);
  }

  async function checkWan() {
    const ok = await online();
    const t = now();
    if (ok) {
      fails = 0;
      lastOkAt = t;
      const macs = sessions.thaw(t);
      for (const mac of macs) {
        try { firewall.allow(mac); } catch (e) { log(`Watchdog: firewall allow ${mac} failed: ${e.message}`); }
      }
      if (macs.length) save();
      if (outageSince !== null) {
        const mins = Math.round((t - outageSince) / 60000);
        recoveries += 1;
        log(`Watchdog: internet back after ${mins} min, time returned to ${macs.length} clients`);
        notify('Internet back', `Down ${mins} min, time returned to ${macs.length} clients`);
        outageSince = null;
      } else if (macs.length) {
        log(`Watchdog: time returned to ${macs.length} clients frozen before a restart`);
      }
      return;
    }
    fails += 1;
    if (outageSince === null) {
      if (fails < FAILS_TO_DOWN) return;
      outageSince = t;
      lastWanTry = t;
      notifiedDown = false;
      const frozen = sessions.freeze(t);
      save();
      log(`Watchdog: internet down, time frozen for ${frozen.length} clients, restarting wan`);
      await run(['ifup', 'wan']);
    } else if (t - lastWanTry >= WAN_RETRY_MS) {
      lastWanTry = t;
      if (!notifiedDown) { notifiedDown = true; notify('Internet down', `No internet since ${hhmm(outageSince)}`); }
      await run(['ifup', 'wan']);
    }
  }

  async function tick() {
    if (busy) return; // slow pings: the previous pass is still running
    busy = true;
    try {
      await checkLan();
      await checkWan();
    } finally {
      busy = false;
    }
  }

  const status = () => ({ wanUp: outageSince === null, lastOkAt, outageSince, recoveries });

  return { tick, status };
}

module.exports = { createWatchdog };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/watchdog.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/system/watchdog.js test/watchdog.test.js
git commit -m "Watchdog: freeze client time while the internet is down, restart wan/lan, notify"
```

---

### Task 4: Wire the watchdog into `main.js`

**Files:**
- Modify: `main.js` (require; hoist notifications next to the session store; pass it to nav; start the watchdog after the shaper block)

**Interfaces:**
- Consumes: `createWatchdog` (Task 3), `createNotifications` (existing), `session`, `firewall`, `admin.mainlog`.

- [ ] **Step 1: Implement**

Near the other `lib/system` requires:

```js
const { createWatchdog } = require('./lib/system/watchdog');
```

Right after `session.load();` (line ~93), so it exists with or without the admin page:

```js
const notifications = createNotifications({ file: path.join(stateDir, 'notification.json') });
```

In the `createNavHandlers({ ... })` call replace
`notifications: createNotifications({ file: path.join(stateDir, 'notification.json') }),` with `notifications,`.

After the shaper `if (admin) { ... }` block and before the expiry `setInterval`:

```js
// Internet/LAN watchdog. Off OpenWrt (a laptop) there is no br-lan to look after, so only the ping/freeze part runs.
{
  const nodeFs = require('node:fs');
  const { execFile } = require('node:child_process');
  const onOpenWrt = nodeFs.existsSync('/etc/openwrt_release');
  const exec = (argv) => new Promise((ok, fail) => execFile(argv[0], argv.slice(1), { timeout: 15000 }, (e, out) => (e ? fail(e) : ok(out))));
  const watchdog = createWatchdog({
    exec,
    linkExists: (dev) => !onOpenWrt || nodeFs.existsSync(`/sys/class/net/${dev}`),
    sessions: session,
    firewall,
    notifications,
    mainlog: admin ? admin.mainlog : { write: (c, text) => log('info', text) },
    save: () => session.save(),
  });
  setInterval(() => { watchdog.tick().catch((e) => log('error', 'watchdog pass failed', { error: e.message })); }, 30000).unref();
}
```

- [ ] **Step 2: Run the whole suite**

Run: `npm test`
Expected: all PASS (main.test.js starts main.js with the watchdog wired).

- [ ] **Step 3: Smoke-run on the dev machine**

Run: `VENDO5_FIREWALL_CMD=noop VENDO5_STATE_DIR=$(mktemp -d) timeout 40 node main.js; echo exit=$?`
Expected: starts, no `watchdog pass failed` line, `exit=124` (killed by timeout).

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "Start the internet/LAN watchdog every 30 s"
```

---

### Task 5: On-device check (manual, Orange Pi)

- [ ] **Step 1:** Confirm procd feeds the hardware watchdog: `ubus call system watchdog` shows `"status": "running"`. If not, note it in `docs/hardware-checklist.md`.
- [ ] **Step 2:** With a client connected, unplug the WAN cable for 3 minutes. Expected: within ~90 s the portal shows "Paused"; the admin log has "internet down, time frozen". Plug back in. Expected within 30 s: client online again, same remaining time, bell notification "Internet back".
- [ ] **Step 3:** Admin dashboard -> active session -> pause button: client paused; press again: resumed.
- [ ] **Step 4:** Add the results to `docs/hardware-checklist.md` and commit.
