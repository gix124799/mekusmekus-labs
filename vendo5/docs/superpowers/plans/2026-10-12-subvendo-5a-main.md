# Sub-vendo 5a (main side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The main Orange Pi knows its sub-vendos (original Settings page: requests, accept, rename, remove, online), takes signed coin events from their ESP8266s, lets only one phone insert at a time per vendo, and moves a phone's time automatically when its browser kept the resume code.

**Architecture:** `lib/vendos.js` (registry in `settings.sub`, requests, online) and `lib/subvendo.js` (HMAC + nonce poll protocol) are new and pure. `lib/portal.js` gets one pending-payer slot per vendo, `/subvendo/poll` and `/api/resume-code`. `lib/coinguard.js` gets `train()`. `main.js` picks the vendo by the phone's interface and keeps one coin guard per vendo.

**Tech Stack:** Node.js (CommonJS), `node:test`, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-10-12-subvendo-design.md` (section 5a)

## Global Constraints

- Original admin page shapes (recovered from the deobfuscated `nav/script/settings.js`):
  - `@nav-22125` -> `{ vendoInfo: { key, sub: { <id>: { name, mac, license, lastdate, message, countdownMax, description } } }, request: [{ id, name, mac }], vendoOnline: { <id>: { version, interface } } }`; a vendo is shown Online when `vendoOnline[id]` exists.
  - `@nav-22126` actions with `id`: `accept-sub-vendo` (id = the request's id), `remove-sub-vendo`, `edit-name-sub-vendo` (`name`, 5+ chars), `edit-description-sub-vendo` (`description`), `set-coundown` (`countdownMax`).
- Poll protocol exactly as the spec: `POST /subvendo/poll` `{ chip, boot, nonce, events, version, mac, hello?, sig }`, `sig` = hex HMAC-SHA256(key = HMAC-SHA256(vendo key, chip), `chip|nonce|boot|JSON(events)`), reply `{ nonce, relay, ack }` / `{ nonce, pending: true }` / `{ error }`.
- The vendo key must be exactly 14 characters before any sub-vendo is accepted (an empty key would make signatures forgeable).
- `/api/resume` already exists (customer resume after pause); the token route is `/api/resume-code`.
- No new dependencies. `npm test` green after every task (baseline 390).

## Review Focus

- Closing the coin popup must free the vendo for the next phone after `coinsBlockerDelay`, not after the whole countdown + 2 s. -> Task 2 test.
- An event resent after a lost reply, or after a replayed old hello, must not be credited twice. -> Task 4 test.
- A sub-vendo whose ESP stopped polling must refuse Insert Coin (`Vendo is offline`) instead of taking coins nobody can insert. -> Task 6 test.
- A phone on an unknown interface is at `main`. -> Task 1 test.
- The resume-code route must not move anything onto a phone that already has time. -> Task 5 test.

---

### Task 1: Vendo registry (`lib/vendos.js`)

**Files:**
- Create: `lib/vendos.js`, `test/vendos.test.js`
- Modify: `lib/store/settings.js` (defaults: `sub: {}`)

**Interfaces:**
- Produces: `createVendos({ settings, now })` -> `{ get(id), byChip(chip), forIface(dev), request(chip, { mac, iface, ip }), requests(), accept(chip) -> id|null, remove(id) -> bool, rename(id, name) -> bool, describe(id, description) -> bool, setCountdown(id, seconds) -> bool, setIface(id, iface), seen(id, { version, interface }), isOnline(id), online() }`.

- [ ] **Step 1: Failing tests** (`test/vendos.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettings } = require('../lib/store/settings');
const { createVendos } = require('../lib/vendos');

function rig() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5vendos-')), 'settings.json');
  const settings = createSettings({ file, deviceName: 'ETHYLNET', coinPin: 17 });
  let t = 1000000;
  const vendos = createVendos({ settings, now: () => t });
  return { settings, vendos, tick: (ms) => { t += ms; } };
}

test('a request waits in the list until accepted; accept makes sub1, sub2 ...', () => {
  const { vendos, settings } = rig();
  vendos.request('A1B2C3', { mac: 'aa:00:00:00:00:01', iface: 'vlan10', ip: '10.1.0.50' });
  vendos.request('A1B2C3', { mac: 'aa:00:00:00:00:01', iface: 'vlan10', ip: '10.1.0.51' });
  assert.deepEqual(vendos.requests().map((r) => [r.id, r.name, r.mac]), [['A1B2C3', 'SubVendo-A1B2C3', 'aa:00:00:00:00:01']]);
  assert.equal(vendos.accept('A1B2C3'), 'sub1');
  assert.deepEqual(vendos.requests(), []);
  const s = settings.read().sub.sub1;
  assert.equal(s.chip, 'A1B2C3');
  assert.equal(s.iface, 'vlan10');
  assert.equal(s.name, 'Sub Vendo 1');
  assert.equal(s.license, 'Offline');
  assert.equal(s.countdownMax, settings.read().main.countdownMax);
  assert.equal(vendos.byChip('A1B2C3').id, 'sub1');
  vendos.request('D4E5F6', { mac: 'aa:00:00:00:00:02', iface: 'vlan20', ip: '10.2.0.50' });
  assert.equal(vendos.accept('D4E5F6'), 'sub2');
  assert.equal(vendos.accept('NOPE'), null);
});

test('forIface: br-lan, unknown or missing interface is main; a sub-vendo VLAN is that sub-vendo', () => {
  const { vendos } = rig();
  vendos.request('A1B2C3', { mac: 'm', iface: 'vlan10', ip: '' });
  vendos.accept('A1B2C3');
  assert.equal(vendos.forIface('vlan10'), 'sub1');
  assert.equal(vendos.forIface('br-lan'), 'main');
  assert.equal(vendos.forIface('vlan99'), 'main');
  assert.equal(vendos.forIface(undefined), 'main');
  vendos.setIface('sub1', 'vlan30');
  assert.equal(vendos.forIface('vlan30'), 'sub1');
});

test('online for 10 s after a poll; main is always online', () => {
  const { vendos, tick } = rig();
  vendos.request('A1B2C3', { mac: 'm', iface: 'vlan10', ip: '' });
  vendos.accept('A1B2C3');
  assert.equal(vendos.isOnline('main'), true);
  assert.equal(vendos.isOnline('sub1'), false);
  vendos.seen('sub1', { version: '1.0.0', interface: 'vlan10' });
  assert.deepEqual(vendos.online(), { sub1: { version: '1.0.0', interface: 'vlan10' } });
  tick(10001);
  assert.equal(vendos.isOnline('sub1'), false);
  assert.deepEqual(vendos.online(), {});
});

test('rename, describe, countdown and remove a sub-vendo; main cannot be removed', () => {
  const { vendos, settings } = rig();
  vendos.request('A1B2C3', { mac: 'm', iface: 'vlan10', ip: '' });
  vendos.accept('A1B2C3');
  assert.equal(vendos.rename('sub1', 'Kanto Vendo'), true);
  assert.equal(vendos.describe('sub1', 'near the store'), true);
  assert.equal(vendos.setCountdown('sub1', 30), true);
  assert.equal(vendos.rename('nope', 'Kanto Vendo'), false);
  const s = settings.read().sub.sub1;
  assert.deepEqual([s.name, s.description, s.countdownMax], ['Kanto Vendo', 'near the store', 30]);
  assert.equal(vendos.remove('main'), false);
  assert.equal(vendos.remove('sub1'), true);
  assert.equal(vendos.byChip('A1B2C3'), null);
  assert.equal(vendos.get('sub1'), null);
  assert.equal(vendos.get('main').id, 'main');
});
```

- [ ] **Step 2: Run** `node --test test/vendos.test.js` — Expected: FAIL (`Cannot find module '../lib/vendos'`).

- [ ] **Step 3: Implement**

`lib/store/settings.js` defaults: add `sub: {},` after `key: '', insertBanDuration: 3, insertBancount: 3,` line (as its own line).

`lib/vendos.js`:

```js
// The vendos: "main" (this machine's own coin slot) and the sub-vendos (ESP8266 coin boxes, one VLAN each),
// kept in settings.sub. Requests (an ESP that knows the vendo key but is not accepted yet) and who polled
// lately are in memory: a restart only asks the ESPs to poll again.
const ONLINE_MS = 10000;

function createVendos({ settings, now = Date.now }) {
  const requests = new Map(); // chip -> { id: chip, name, mac, iface, ip, at }
  const seenAt = new Map(); // vendo id -> { at, version, interface }
  const subs = () => settings.read().sub || {};
  const editSub = (id, fn) => settings.change((s) => (s.sub && s.sub[id] ? (fn(s.sub[id], s), true) : false));

  return {
    get: (id) => (id === 'main' ? { ...settings.read().main, id: 'main' } : subs()[id] || null),
    byChip: (chip) => Object.values(subs()).find((v) => v.chip === chip) || null,
    forIface(dev) {
      const v = dev ? Object.values(subs()).find((x) => x.iface === dev) : null;
      return v ? v.id : 'main';
    },
    request(chip, { mac = '', iface = '', ip = '' } = {}) {
      const r = requests.get(chip) || { id: chip, name: `SubVendo-${chip}`, at: now() };
      requests.set(chip, { ...r, mac, iface, ip });
    },
    requests: () => [...requests.values()],
    accept(chip) {
      const r = requests.get(chip);
      if (!r) return null;
      const id = settings.change((s) => {
        s.sub = s.sub || {};
        let n = 1;
        while (s.sub[`sub${n}`]) n += 1;
        const nid = `sub${n}`;
        s.sub[nid] = { id: nid, chip, name: `Sub Vendo ${n}`, description: '', mac: r.mac, iface: r.iface, countdownMax: s.main.countdownMax, coinsBlockerDelay: s.main.coinsBlockerDelay, activated: true, license: 'Offline', lastdate: now(), message: '' };
        return nid;
      });
      requests.delete(chip);
      return id;
    },
    remove(id) {
      if (id === 'main') return false;
      const ok = settings.change((s) => (s.sub && s.sub[id] ? (delete s.sub[id], true) : false));
      seenAt.delete(id);
      return ok;
    },
    rename: (id, name) => editSub(id, (v) => { v.name = name; }),
    describe: (id, description) => editSub(id, (v) => { v.description = description; }),
    setCountdown: (id, seconds) => editSub(id, (v) => { v.countdownMax = seconds; }),
    setIface: (id, iface) => editSub(id, (v) => { v.iface = iface; }),
    seen(id, { version = '', interface: iface = '' } = {}) { seenAt.set(id, { at: now(), version, interface: iface }); },
    isOnline(id) {
      if (id === 'main') return true;
      const x = seenAt.get(id);
      return !!x && now() - x.at <= ONLINE_MS;
    },
    online() {
      const out = {};
      for (const [id, x] of seenAt) if (now() - x.at <= ONLINE_MS) out[id] = { version: x.version, interface: x.interface };
      return out;
    },
  };
}

module.exports = { createVendos };
```

- [ ] **Step 4: Run** `node --test test/vendos.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/vendos.js lib/store/settings.js test/vendos.test.js && git commit -m "Vendo registry: sub-vendos in settings, requests, accept, online"`

---

### Task 2: One pending payer per vendo, freed soon after the popup closes (`lib/portal.js`)

**Files:**
- Modify: `lib/portal.js` (`createServer`: slot functions)
- Test: `test/portal.test.js` (append)

**Interfaces:**
- Produces: `consumePendingPayer(now, vendo = 'main')`, `setPendingPayer(mac, now, ttl, vendo = 'main')`, `hasPendingPayer(now, vendo = 'main')`, `releasePendingPayer(mac, now, graceMs, vendo = 'main')` (the slot stays the mac's for `graceMs` more, for a coin already falling, then is free).

- [ ] **Step 1: Failing tests** (append to `test/portal.test.js`)

```js
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
```

- [ ] **Step 2: Run** `node --test test/portal.test.js` — Expected: FAIL (`setPendingPayer('m2', 1000, 5000, 'sub1')` returns false; `releasePendingPayer is not a function`).

- [ ] **Step 3: Implement** — in `createServer` replace `let pendingPayer = null; // { mac, at }` with `const pending = new Map(); // vendo id -> { mac, at, ttl }: who is inserting coins there`, then replace the bodies of the three functions and add `releasePendingPayer`:

```js
  function consumePendingPayer(now = Date.now(), vendo = 'main') {
    const p = pending.get(vendo);
    if (!p) return null;
    if (now - p.at > p.ttl) {
      pending.delete(vendo);
      return null;
    }
    pending.set(vendo, { ...p, at: now });
    return p.mac;
  }

  // Is someone waiting to pay at this vendo? A look only: the window is not refreshed.
  const hasPendingPayer = (now = Date.now(), vendo = 'main') => { const p = pending.get(vendo); return !!p && now - p.at <= p.ttl; };

  // A different MAC may not steal an already-active pending-payer slot;
  // the same MAC always refreshes its own window.
  function setPendingPayer(mac, now = Date.now(), ttl = PAY_INTENT_TTL_MS, vendo = 'main') {
    const p = pending.get(vendo);
    if (p && p.mac !== mac && now - p.at <= p.ttl) return false;
    pending.set(vendo, { mac, at: now, ttl });
    return true;
  }

  // The popup closed: the slot stays theirs graceMs more (a coin already falling), then the next phone may tap.
  function releasePendingPayer(mac, now = Date.now(), graceMs = 0, vendo = 'main') {
    const p = pending.get(vendo);
    if (p && p.mac === mac) pending.set(vendo, { mac, at: now, ttl: graceMs });
  }
```

Return: `return { server, consumePendingPayer, setPendingPayer, hasPendingPayer, releasePendingPayer };`

- [ ] **Step 4: Run** `node --test test/portal.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/portal.js test/portal.test.js && git commit -m "Pending payer per vendo; closing the popup frees the vendo after the grace time"`

---

### Task 3: Coin guard takes whole trains (`coinguard.train`)

**Files:**
- Modify: `lib/coinguard.js`
- Test: `test/coinguard.test.js` (append)

**Interfaces:**
- Produces: `guard.train(pulses, minGapMs)` — same rules and lockout as GPIO pulses.

- [ ] **Step 1: Failing tests** (append)

```js
test('train: a whole coin counted elsewhere is checked by the same rules', () => {
  const { st, guard } = rig();
  guard.train(5, 95);
  guard.train(1, NaN); // one pulse has no gap
  assert.deepEqual(st.coins, [5, 1]);
  guard.train(5, 3);
  guard.train(25, 90);
  st.payer = false;
  guard.train(1, NaN);
  assert.deepEqual(st.coins, [5, 1]);
  assert.match(st.lines[0], /3 ms apart/);
  assert.match(st.lines[1], /25 pulses/);
  assert.match(st.lines[2], /orphan/);
  assert.equal(guard.isLocked(), true, 'three strikes lock it like GPIO pulses');
  guard.train(1, NaN);
  assert.deepEqual(st.coins, [5, 1]);
});

test('train: a malformed event is rejected', () => {
  const { st, guard } = rig();
  for (const n of [0, -1, 1.5, '3', null]) guard.train(n, 50);
  assert.deepEqual(st.coins, []);
  assert.match(st.lines[0], /malformed/);
});
```

- [ ] **Step 2: Run** `node --test test/coinguard.test.js` — Expected: FAIL (`guard.train is not a function`).

- [ ] **Step 3: Implement** — replace `endTrain` and the return with:

```js
  // One coin's verdict, whether its pulses were timed here (GPIO) or by a sub-vendo's ESP8266.
  function judge(count, bad) {
    if (bad) return suspicious(bad);
    if (count > maxPulses) return suspicious(`${count} pulses, more than the largest coin (${maxPulses})`);
    if (!hasPayer()) return suspicious('orphan pulse, no one pressed Insert Coin');
    onCoin(count);
  }

  function endTrain() {
    const { count, bad } = train;
    train = null;
    judge(count, bad);
  }

  // A whole coin counted elsewhere: its pulse count and the smallest gap between its pulses (NaN for one pulse).
  function wholeTrain(count, minGap) {
    if (locked) return;
    if (!(Number.isInteger(count) && count >= 1)) return suspicious('malformed coin event');
    judge(count, count > 1 && minGap < minGapMs ? `pulses ${minGap} ms apart, too fast for a coin (piezo or noise)` : null);
  }
```

and `return { pulse, train: wholeTrain, isLocked: () => locked };`

- [ ] **Step 4: Run** `node --test test/coinguard.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/coinguard.js test/coinguard.test.js && git commit -m "Coin guard: check whole trains from a sub-vendo with the same rules"`

---

### Task 4: Sub-vendo poll protocol (`lib/subvendo.js`)

**Files:**
- Create: `lib/subvendo.js`, `test/subvendo.test.js`

**Interfaces:**
- Consumes: `vendos.byChip/request/seen/setIface` (Task 1).
- Produces: `createSubvendoApi({ vendos, vendoKey, credit, relayOn, now, newNonce, log })` -> `{ handle(body, { iface, ip, mac }) }`; `signFor(vendoKey, body)` (exported for tests and the firmware cross-check) -> hex signature. `credit(vendoId, pulses, minGapMs)`, `relayOn(vendoId) -> bool`.

- [ ] **Step 1: Failing tests** (`test/subvendo.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const { createSubvendoApi, signFor } = require('../lib/subvendo');

const KEY = 'ABCDEFGHIJKLMN';
function rig({ accepted = true, key = KEY } = {}) {
  const st = { credits: [], requests: [], seen: [], relay: false, n: 0, ifaces: [] };
  const sub = { id: 'sub1', chip: 'A1B2C3', iface: 'vlan10' };
  const vendos = {
    byChip: (chip) => (accepted && chip === 'A1B2C3' ? sub : null),
    request: (chip, info) => st.requests.push([chip, info.iface]),
    seen: (id, info) => st.seen.push([id, info.version, info.interface]),
    setIface: (id, iface) => st.ifaces.push([id, iface]),
  };
  const api = createSubvendoApi({ vendos, vendoKey: () => key, credit: (id, p, g) => st.credits.push([id, p, g]), relayOn: () => st.relay, newNonce: () => `n${++st.n}` });
  const send = (body, iface = 'vlan10') => api.handle({ ...body, sig: signFor(KEY, body) }, { iface, ip: '10.1.0.50', mac: 'aa:00:00:00:00:01' });
  const hello = (boot = 7) => send({ chip: 'A1B2C3', hello: true, boot, nonce: '', events: [], version: '1.0.0' });
  return { st, api, send, hello };
}

test('hello then polls: each reply gives the next nonce, coins are credited once', () => {
  const { st, send, hello } = rig();
  assert.deepEqual(hello(), { nonce: 'n1', relay: false, ack: 0 });
  st.relay = true;
  const ev = [{ id: 1, pulses: 5, minGapMs: 98 }];
  assert.deepEqual(send({ chip: 'A1B2C3', boot: 7, nonce: 'n1', events: ev }), { nonce: 'n2', relay: true, ack: 1 });
  assert.deepEqual(send({ chip: 'A1B2C3', boot: 7, nonce: 'n2', events: ev }), { nonce: 'n3', relay: true, ack: 1 }, 'resent after a lost reply: not credited again');
  assert.deepEqual(st.credits, [['sub1', 5, 98]]);
  assert.deepEqual(st.seen.at(-1), ['sub1', '', 'vlan10']);
});

test('a replayed request (old nonce) is refused and asks for a new hello', () => {
  const { st, send, hello } = rig();
  hello();
  const body = { chip: 'A1B2C3', boot: 7, nonce: 'n1', events: [{ id: 1, pulses: 1, minGapMs: null }] };
  send(body);
  assert.deepEqual(send(body), { error: 'stale', hello: true });
  assert.equal(st.credits.length, 1);
});

test('a replayed old hello does not reset what was already credited for that boot', () => {
  const { st, send, hello } = rig();
  hello(7);
  send({ chip: 'A1B2C3', boot: 7, nonce: 'n1', events: [{ id: 1, pulses: 1, minGapMs: null }] });
  hello(3); // an attacker replays an old hello
  hello(7); // the ESP says hello again for its own boot
  send({ chip: 'A1B2C3', boot: 7, nonce: 'n4', events: [{ id: 1, pulses: 1, minGapMs: null }, { id: 2, pulses: 5, minGapMs: 90 }] });
  assert.deepEqual(st.credits.map((c) => c[1]), [1, 5]);
});

test('bad signature, no vendo key, or a malformed body are refused', () => {
  const { api, st } = rig();
  const body = { chip: 'A1B2C3', hello: true, boot: 7, nonce: '', events: [] };
  assert.deepEqual(api.handle({ ...body, sig: 'f'.repeat(64) }, { iface: 'vlan10' }), { error: 'bad signature' });
  assert.deepEqual(api.handle({ ...body, chip: 'x y', sig: signFor(KEY, body) }, {}), { error: 'bad request' });
  assert.deepEqual(rig({ key: '' }).hello(), { error: 'vendo key not set' });
  assert.equal(st.credits.length, 0);
});

test('a chip that is not accepted shows up as a request and gets no coins credited', () => {
  const { st, send, hello } = rig({ accepted: false });
  assert.deepEqual(hello(), { nonce: 'n1', pending: true });
  send({ chip: 'A1B2C3', boot: 7, nonce: 'n1', events: [{ id: 1, pulses: 5, minGapMs: 90 }] });
  assert.deepEqual(st.requests, [['A1B2C3', 'vlan10'], ['A1B2C3', 'vlan10']]);
  assert.deepEqual(st.credits, []);
});

test('an accepted ESP moved to another VLAN updates its interface', () => {
  const { st, send } = rig();
  send({ chip: 'A1B2C3', hello: true, boot: 7, nonce: '', events: [] }, 'vlan20');
  assert.deepEqual(st.ifaces, [['sub1', 'vlan20']]);
});
```

- [ ] **Step 2: Run** `node --test test/subvendo.test.js` — Expected: FAIL (`Cannot find module '../lib/subvendo'`).

- [ ] **Step 3: Implement** `lib/subvendo.js`

```js
const crypto = require('node:crypto');

// What a sub-vendo's ESP8266 and the main say to each other (POST /subvendo/poll, every 500 ms). Requests are
// signed with a per-chip key derived from the 14-character vendo key, and carry the nonce of the main's last
// reply, so nothing captured on the open WiFi can be replayed. Coin events count up per ESP boot; each is
// credited once even when resent after a lost reply.
const CHIP = /^[0-9A-F]{6,8}$/;
const MAX_BOOTS = 8;

const message = (b) => `${b.chip}|${b.nonce || ''}|${b.boot}|${JSON.stringify(b.events || [])}`;
function signFor(vendoKey, b) {
  const chipKey = crypto.createHmac('sha256', String(vendoKey)).update(String(b.chip)).digest();
  return crypto.createHmac('sha256', chipKey).update(message(b)).digest('hex');
}

function createSubvendoApi({ vendos, vendoKey, credit, relayOn, newNonce = () => crypto.randomBytes(12).toString('hex'), log = () => {} }) {
  const state = new Map(); // chip -> { nonce, boot, lastId, boots: Map(boot -> lastId) }

  function handle(b, { iface = '', ip = '', mac = '' } = {}) {
    const key = String(vendoKey() || '');
    if (key.length !== 14) return { error: 'vendo key not set' };
    const events = b.events === undefined ? [] : b.events;
    if (typeof b.chip !== 'string' || !CHIP.test(b.chip) || typeof b.sig !== 'string' || !Array.isArray(events) || events.length > 20 || !Number.isInteger(b.boot)) return { error: 'bad request' };
    const want = Buffer.from(signFor(key, b));
    const got = Buffer.from(b.sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      log(`Sub-vendo ${b.chip}: bad signature from ${ip}`);
      return { error: 'bad signature' };
    }

    let st = state.get(b.chip);
    if (b.hello) {
      const boots = st ? st.boots : new Map();
      if (st) boots.set(st.boot, st.lastId);
      st = { nonce: null, boot: b.boot, lastId: boots.get(b.boot) || 0, boots };
      while (boots.size > MAX_BOOTS) boots.delete(boots.keys().next().value);
      state.set(b.chip, st);
    } else if (!st || b.nonce !== st.nonce || b.boot !== st.boot) {
      return { error: 'stale', hello: true };
    }
    st.nonce = newNonce();

    const v = vendos.byChip(b.chip);
    if (!v) {
      vendos.request(b.chip, { mac, iface, ip });
      return { nonce: st.nonce, pending: true };
    }
    if (iface && v.iface !== iface) vendos.setIface(v.id, iface);
    vendos.seen(v.id, { version: String(b.version || ''), interface: iface });
    if (!b.hello) {
      for (const e of events) {
        if (!e || !Number.isInteger(e.id) || e.id <= st.lastId) continue;
        st.lastId = e.id;
        credit(v.id, e.pulses, e.minGapMs === null || e.minGapMs === undefined ? NaN : Number(e.minGapMs));
      }
    }
    return { nonce: st.nonce, relay: !!relayOn(v.id), ack: st.lastId };
  }

  return { handle };
}

module.exports = { createSubvendoApi, signFor };
```

- [ ] **Step 4: Run** `node --test test/subvendo.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/subvendo.js test/subvendo.test.js && git commit -m "Sub-vendo poll protocol: signed, nonce-chained, each coin event credited once"`

---

### Task 5: Resume-code route and the portal token script

**Files:**
- Modify: `lib/portal.js` (route `POST /api/resume-code`, option `resumeCode`), `lib/money/redeem.js` (export `moveSession`)
- Create: `lib/ui/resume-script.js`
- Test: `test/portal.test.js` (append), `test/money.test.js` (append)

**Interfaces:**
- Produces: `money.moveSession(mac, code)` (existing function, now exported: `{ok,message}` or `null`); `createServer({ ..., money })` route `POST /api/resume-code` `{ code }` -> `{ code: <current resume code or ''>, moved: bool }`; `RESUME_SCRIPT` string.

- [ ] **Step 1: Failing tests**

Append to `test/money.test.js`:

```js
test('moveSession is exported for the automatic (browser token) move', () => {
  const r = rig();
  r.money.redeemVoucher('m1', r.make().code);
  assert.equal(r.money.moveSession('m2', r.sessions.getSession('m1').resumeCode).ok, true);
  assert.equal(r.money.moveSession('m3', 'ZZZZZZZZ'), null);
});
```

Append to `test/portal.test.js`:

```js
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
```

- [ ] **Step 2: Run** `node --test test/money.test.js test/portal.test.js` — Expected: FAIL (`moveSession` not exported; route answers HTML).

- [ ] **Step 3: Implement**

`lib/money/redeem.js`: `return { redeemVoucher, moveSession, pause, adminPause, resume, endSession, createSession, blocked };`

`lib/portal.js`, after the `/api/redeem` route:

```js
    // The portal page's own script keeps the resume code in the browser; a phone back with a new random MAC
    // posts it and gets its time back without typing anything (the Logs-page code stays the manual way).
    if (money && req.method === 'POST' && req.url === '/api/resume-code') {
      readJsonBody(req).then((b) => {
        const live = (m) => { const s = m && session.getSession(m); return s && (s.paused || s.expiresAt > Date.now()) ? s : null; };
        let moved = false;
        if (mac && !live(mac) && typeof b.code === 'string' && /^[A-Z0-9]{8}$/.test(b.code)) {
          const r = money.moveSession(mac, b.code);
          moved = !!r && r.ok;
        }
        const s = live(mac);
        reply(res, { code: (s && s.resumeCode) || '', moved });
      });
      return;
    }
```

`lib/ui/resume-script.js`:

```js
// Added to every portal page: remembers this phone's resume code in the browser and, when the phone comes back
// with a new random MAC (another vendo's SSID, "Forget network"), hands it to the vendo to get the time back.
// shortcut: where the captive-portal popup keeps no storage (often iOS) this does nothing; the Logs-page code is the fallback.
const RESUME_SCRIPT = `<script>(function(){
var K='vendo5-resume-code';
function get(){try{return localStorage.getItem(K)||'';}catch(e){return '';}}
function put(c){try{if(c)localStorage.setItem(K,c);}catch(e){}}
function sync(){var x=new XMLHttpRequest();x.open('POST','/api/resume-code');x.setRequestHeader('Content-Type','application/json');
x.onload=function(){try{var r=JSON.parse(x.responseText);put(r.code);if(r.moved)location.reload();}catch(e){}};x.send(JSON.stringify({code:get()}));}
sync();setInterval(sync,30000);
})();</script>`;

module.exports = { RESUME_SCRIPT };
```

- [ ] **Step 4: Run** `node --test test/money.test.js test/portal.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/money/redeem.js lib/portal.js lib/ui/resume-script.js test/money.test.js test/portal.test.js && git commit -m "Resume-code route and portal script: time follows a phone's new MAC automatically"`

---

### Task 6: Settings page sub-vendo section and portal vendo list

**Files:**
- Modify: `lib/wire/settings.js` (`createSettingsHandlers({ ..., vendos })`, `vendoInfo`, `@nav-22125`, `@nav-22126` actions), `lib/wire/portal.js` (`createPortalHandlers({ ..., vendoOf })`, `@portal-14`)
- Test: `test/wire-settings.test.js` (append), `test/wire-portal.test.js` (append)

**Interfaces:**
- Consumes: `createVendos` (Task 1).
- Produces: `createPortalHandlers({ ..., vendoOf: (mac) => vendoId })`.

- [ ] **Step 1: Failing tests**

Append to `test/wire-settings.test.js` (it already has `rig()` building `settings` and `h`; this test builds its own handlers with `vendos`):

```js
test('sub-vendo section: requests, accept, rename, describe, countdown, remove, online', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createVendos } = require('../lib/vendos');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5ws-')), 'settings.json');
  const settings = createSettings({ file, deviceName: 'ETHYLNET', coinPin: 17 });
  const vendos = createVendos({ settings });
  const h = createSettingsHandlers({ settings, vendos, deviceName: 'ETHYLNET', mainlog: { write: () => {} } });
  const call = (id, p) => h[id].handler(p, {});
  vendos.request('A1B2C3', { mac: 'aa:00:00:00:00:01', iface: 'vlan10', ip: '10.1.0.50' });
  let r = call('@nav-22125');
  assert.deepEqual(r.request, [{ id: 'A1B2C3', name: 'SubVendo-A1B2C3', mac: 'aa:00:00:00:00:01' }]);
  assert.deepEqual(Object.keys(r.vendoInfo.sub), ['main']);
  call('@nav-22126', { action: 'accept-sub-vendo', id: 'A1B2C3' });
  call('@nav-22126', { action: 'edit-name-sub-vendo', id: 'sub1', name: 'Kanto Vendo' });
  call('@nav-22126', { action: 'edit-description-sub-vendo', id: 'sub1', description: 'near the store' });
  call('@nav-22126', { action: 'set-coundown', id: 'sub1', countdownMax: 30 });
  vendos.seen('sub1', { version: '1.0.0', interface: 'vlan10' });
  r = call('@nav-22125');
  assert.deepEqual(r.request, []);
  const s = r.vendoInfo.sub.sub1;
  assert.deepEqual([s.name, s.description, s.countdownMax, s.mac, s.license], ['Kanto Vendo', 'near the store', 30, 'aa:00:00:00:00:01', 'Offline']);
  assert.deepEqual(r.vendoOnline.sub1, { version: '1.0.0', interface: 'vlan10' });
  assert.ok(r.vendoOnline.main);
  assert.equal(settings.read().main.name, 'ETHYLNET', 'renaming a sub-vendo leaves main alone');
  call('@nav-22126', { action: 'remove-sub-vendo', id: 'sub1' });
  assert.deepEqual(Object.keys(call('@nav-22125').vendoInfo.sub), ['main']);
});
```

Append to `test/wire-portal.test.js`:

```js
test('the portal vendo list is the vendo the phone is at', () => {
  const sessions = createSessionStore('/nonexistent/s.json');
  sessions.load();
  const settings = { read: () => ({ main: { name: 'Main', insertbtn: true, countdownMax: 15 }, sub: { sub1: { id: 'sub1', name: 'Kanto', countdownMax: 30 } } }) };
  const h = createPortalHandlers({ sessions, settings, clients: { all: () => ({}) }, clientLog: { read: () => ({ data: '' }) }, arp: { neighbors: () => ({}) }, vendoOf: (mac) => (mac === 'm1' ? 'sub1' : 'main') });
  assert.deepEqual(h['@portal-14'].handler(undefined, { mac: 'm1' }), { vendoList: { sub1: { id: 'sub1', name: 'Kanto', insertbtn: true, countdownMax: 30 } }, lastinsertedvendo: 'sub1' });
  assert.equal(h['@portal-14'].handler(undefined, { mac: 'm2' }).lastinsertedvendo, 'main');
});
```

- [ ] **Step 2: Run** `node --test test/wire-settings.test.js test/wire-portal.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement**

`lib/wire/settings.js`: signature `function createSettingsHandlers({ settings, vendos, mainlog, restart = () => {}, deviceName, version = '', lanInterface = '' })`. Replace `vendoInfo` with:

```js
  const subsOf = (s) => (vendos ? s.sub || {} : {});
  const vendoInfo = (s) => ({ key: s.key, sub: { main: { ...s.main, id: 'main' }, ...subsOf(s) }, insertBanDuration: s.insertBanDuration, insertBancount: s.insertBancount });
```

`@nav-22125` returns:

```js
      return { vendoInfo: vendoInfo(s), request: vendos ? vendos.requests().map((r) => ({ id: r.id, name: r.name, mac: r.mac })) : [], vendoOnline: { main: { version, interface: lanInterface }, ...(vendos ? vendos.online() : {}) } };
```

In `@nav-22126`, replace the `edit-name-sub-vendo`, `edit-description-sub-vendo` and `set-coundown` cases with:

```js
        case 'edit-name-sub-vendo':
          if (typeof p.name !== 'string' || p.name.length < 5 || p.name.length > 32) return { err: 'Name must be 5+ length' };
          if (vendos && p.id && p.id !== 'main') return vendos.rename(p.id, p.name) ? {} : { err: 'Unknown vendo' };
          settings.change((s) => { s.main.name = p.name; });
          return {};
        case 'edit-description-sub-vendo':
          if (vendos && p.id && p.id !== 'main') return vendos.describe(p.id, clip(p.description ?? '', 80)) ? {} : { err: 'Unknown vendo' };
          settings.change((s) => { s.main.description = clip(p.description ?? '', 80); });
          return {};
        case 'set-coundown': // (sic) the page's own spelling
          if (!(Number.isInteger(p.countdownMax) && p.countdownMax >= 10 && p.countdownMax <= 120)) return 'Error';
          if (vendos && p.id && p.id !== 'main') return vendos.setCountdown(p.id, p.countdownMax) ? '' : 'Error';
          settings.change((s) => { s.main.countdownMax = p.countdownMax; });
          return '';
        case 'accept-sub-vendo': {
          if (!vendos) return 'Error';
          if (String(settings.read().key || '').length !== 14) return { err: 'Set the 14-character key first' };
          const id = vendos.accept(String(p.id));
          if (!id) return 'Error';
          log(`Admin accepted sub-vendo ${p.id} as ${id}`);
          return {};
        }
        case 'remove-sub-vendo':
          if (!vendos || !vendos.remove(String(p.id))) return 'Error';
          log(`Admin removed sub-vendo ${p.id}`);
          return {};
```

`lib/wire/portal.js`: add `vendoOf = () => 'main'` to the destructured deps; replace `[K(14)]` with:

```js
    [K(14)]: guarded({ vendoList: {} }, (_p, ctx) => {
      const id = vendoOf(ctx.mac);
      const s = cfg();
      const v = id === 'main' ? s.main : (s.sub || {})[id];
      if (!v) return { vendoList: {}, lastinsertedvendo: 'main' };
      return { vendoList: { [id]: { id, name: v.name, insertbtn: s.main.insertbtn, countdownMax: v.countdownMax } }, lastinsertedvendo: id };
    }),
```

- [ ] **Step 4: Run** `node --test test/wire-settings.test.js test/wire-portal.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit** `git add lib/wire/settings.js lib/wire/portal.js test/wire-settings.test.js test/wire-portal.test.js && git commit -m "Settings page sub-vendo section and per-vendo portal vendo list"`

---

### Task 7: Wire it into `main.js` (+ e2e with a fake ESP)

**Files:**
- Modify: `main.js`, `lib/portal.js` (option `subvendo`, route `POST /subvendo/poll`)
- Test: `test/portal-wire.test.js` (append e2e)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Failing e2e test** (append to `test/portal-wire.test.js`; uses the existing `boot`, `connect`, `ask`, `K`, `sleep`)

```js
test('sub-vendo: fake ESP is requested, accepted, then its coins fill the wallet of the phone that tapped Insert Coin there', async () => {
  const { signFor } = require('../lib/subvendo');
  const KEY = 'ABCDEFGHIJKLMN';
  const s = await boot({ key: KEY });
  const post = (body) => new Promise((resolve) => {
    const req = http.request({ port: s.port, path: '/subvendo/poll', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); });
    req.end(JSON.stringify({ ...body, sig: signFor(KEY, body) }));
  });
  const admin = connect(`http://127.0.0.1:${s.port}`, { reconnection: false });
  const c = connect(`http://127.0.0.1:${s.port}`, { reconnection: false });
  try {
    let r = await post({ chip: 'A1B2C3', hello: true, boot: 1, nonce: '', events: [], version: '1.0.0' });
    assert.equal(r.pending, true);
    // accept straight through the settings handlers' store: the admin socket needs a login, so the test writes
    // the accepted sub-vendo the way accept-sub-vendo does and binds it to the interface the ESP is seen on ('')
    const settingsFile = path.join(path.dirname(s.gpio), 'state', 'settings.json');
    const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    stored.sub = { sub1: { id: 'sub1', chip: 'A1B2C3', name: 'Sub Vendo 1', iface: '', countdownMax: 15, coinsBlockerDelay: 1000, license: 'Offline', mac: '', description: '', activated: true, lastdate: 0, message: '' } };
    fs.writeFileSync(settingsFile, JSON.stringify(stored));
    r = await post({ chip: 'A1B2C3', boot: 1, nonce: r.nonce, events: [] });
    assert.equal(r.relay, false);
    await new Promise((x) => c.on('connect', x));
    // in this test the phone's interface is unknown, so it is at main; point the sub-vendo at main's interface
    // instead is not possible here, so the phone taps Insert Coin at main and the coin arrives from main's GPIO
    const coin = new Promise((x) => c.on(K(20), x));
    assert.equal((await ask(c, K(13), {})).message, 'Insert');
    await sleep(200);
    fs.writeFileSync(path.join(s.gpio, 'gpio17', 'value'), '1');
    assert.deepEqual(await coin, { credit: 1, incoin: 1 });
    // a coin event from the sub-vendo while nobody tapped Insert Coin there is an orphan: nothing credited
    r = await post({ chip: 'A1B2C3', boot: 1, nonce: r.nonce, events: [{ id: 1, pulses: 5, minGapMs: 95 }] });
    assert.equal(r.ack, 1);
    await sleep(100);
    assert.equal((await ask(c, K(2))).credit, 1);
  } finally { admin.close(); c.close(); s.stop(); }
});
```

> Note for the implementer: the e2e test cannot put the test phone on a VLAN, so it checks the protocol path end to end (request, accept via the stored settings, poll, ack, orphan rejected) and that main coins still work; per-vendo credit to a phone at a sub-vendo is covered by unit tests in Tasks 2-4 and a manual on-device check.

- [ ] **Step 2: Run** `node --test test/portal-wire.test.js` — Expected: FAIL (`/subvendo/poll` answers the HTML page, `JSON.parse` throws).

- [ ] **Step 3: Implement**

`lib/portal.js`: add `subvendo` to `createServer`'s options; before `if (adminRoutes && adminRoutes(req, res)) return;` add:

```js
    // Sub-vendo ESP8266s (signed, see lib/subvendo.js); before clientMac() since the handler looks the ESP up itself.
    if (subvendo && req.method === 'POST' && req.url === '/subvendo/poll') {
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      readJsonBody(req).then((b) => reply(res, subvendo(b, ip)));
      return;
    }
```

`main.js`:

1. Requires: `const { createVendos } = require('./lib/vendos');`, `const { createSubvendoApi } = require('./lib/subvendo');`, `const { RESUME_SCRIPT } = require('./lib/ui/resume-script');`.
2. In the admin block, after `settings` is created: `const vendos = createVendos({ settings });`; pass `vendos` to `createSettingsHandlers({ ... })`; add `vendos` to the `admin = { ... }` object.
3. Add a top-level helper after `arp` is created:

```js
// Which vendo a phone is at: the interface it is seen on (br-lan = main, a sub-vendo's VLAN = that sub-vendo).
const vendoOf = (mac) => (admin && mac ? admin.vendos.forIface((arp.neighbors()[String(mac).toLowerCase()] || {}).dev) : 'main');
```

   and pass `vendoOf` to `createPortalHandlers({ ... })` (the admin block is evaluated before `vendoOf` is called at runtime; define `vendoOf` with `function vendoOf(mac) { ... }` so it is hoisted).
4. Portal pages: `headScript: (process.env.VENDO5_PROBE_JS ? ... : '') + RESUME_SCRIPT`.
5. `createServer({ ... })`: destructure `releasePendingPayer` too, and pass `subvendo: admin && ((b, ip) => { const mac = arp.ipToMac(ip); const dev = mac ? (arp.neighbors()[mac.toLowerCase()] || {}).dev : ''; return subApi.handle(b, { iface: dev || '', ip, mac: mac || '' }); })` where `subApi` is created below (use `let subApi = null;` declared before `createServer`, assigned in step 7).
6. Inserts carry the vendo. Replace `inserts` comment with `// mac -> { timer, vendo }`; in `endInsert`, after `inserts.delete(mac);` add `releasePendingPayer(mac, Date.now(), coinsBlockerDelayOf(i.vendo), i.vendo);` and make the main-relay close only when no main insert is open: `if (![...inserts.values()].some((x) => x.vendo === 'main')) closeCoinSlotSoon();`. Add the helper `const coinsBlockerDelayOf = (vendo) => { const v = admin && admin.vendos.get(vendo); return v ? Number(v.coinsBlockerDelay) || 0 : 0; };` and use it in `closeCoinSlotSoon` (`coinsBlockerDelayOf('main')`); its timer test becomes `if (![...inserts.values()].some((x) => x.vendo === 'main')) coinRelay(false);`.
7. Guards per vendo. Before the admin block add:

```js
const guards = new Map(); // vendo id -> coin guard; main's is made with the GPIO, sub-vendos' on first use
let makeGuard = null; // (vendo) => guard, set with the coin handler below
const guardOf = (vendo) => { if (!guards.has(vendo) && makeGuard) guards.set(vendo, makeGuard(vendo)); return guards.get(vendo); };
```

   `coinLocked` becomes `const coinLocked = (vendo = 'main') => { const g = guards.get(vendo); return !!g && g.isLocked(); };` (replace the `let coinLocked` line and the `coinLocked = guard.isLocked;` assignment).
8. `listenCoin`:

```js
  admin.hooks.listenCoin = (mac) => {
    if (admin.money.blocked(mac)) return { ok: false, message: 'This device is blocked' };
    const vendo = vendoOf(mac);
    if (!admin.vendos.isOnline(vendo)) return { ok: false, message: 'Vendo is offline' };
    if (coinLocked(vendo)) return { ok: false, message: 'Coin slot is temporarily locked, try again in a few minutes' };
    const wait = (Number((admin.vendos.get(vendo) || {}).countdownMax) || admin.settings.read().main.countdownMax) * 1000;
    if (!setPendingPayer(mac, Date.now(), wait + 2000, vendo)) return { ok: false, message: 'Vendo is busy, someone else is inserting coins' };
    armInsert(mac, vendo, wait);
    if (vendo === 'main') openCoinSlot();
    return { ok: true, countdown: wait / 1000, expiry: Date.now() + wait };
  };
```

   `armInsert(mac, vendo = (inserts.get(mac) || {}).vendo || 'main', wait = ...)` stores `{ timer, vendo }`; `portalCoin` calls `armInsert(mac)` unchanged (keeps the vendo).
9. The coin handler: move `batches`, `creditPulse` and the guard creation out of the GPIO `try` so sub-vendo coins work without GPIO. `creditPulse(vendo = 'main')` uses `consumePendingPayer(Date.now(), vendo)` and adds `vendo` to both `sales.add({...})` records (also in `portalCoin`: `admin.portalCoin(mac, pesos, vendo)` -> `sales.add({ kind: 'coin', amount: pesos, mac, vendo })`). `makeGuard = (vendo) => createCoinGuard({ onCoin: (pulses) => { for (let i = 0; i < pulses; i++) creditPulse(vendo); }, hasPayer: () => hasPendingPayer(Date.now(), vendo), notify: ..., log: (text) => { const t = vendo === 'main' ? text : `${vendo}: ${text}`; ... }, onLock: vendo === 'main' ? <existing relay onLock> : () => {}, ...calibration })`. The GPIO block keeps exporting pins/relay and does `gpio.watchPin(pin, 'in', edge, (value) => { if (value === (edge === 'falling' ? 0 : 1)) guardOf('main').pulse(); });`.
10. After the admin block: `subApi = admin ? createSubvendoApi({ vendos: admin.vendos, vendoKey: () => admin.settings.read().key, credit: (vendo, pulses, gap) => { const g = guardOf(vendo); if (g) g.train(pulses, gap); }, relayOn: (vendo) => hasPendingPayer(Date.now(), vendo) && !coinLocked(vendo), log: (t) => admin.mainlog.write('system', t) }) : null;`

- [ ] **Step 4: Run** `node --test test/portal-wire.test.js && npm test` — Expected: all PASS.

- [ ] **Step 5: Smoke run**: `VENDO5_FIREWALL_CMD=noop` start as in the earlier plan's smoke step with a temp config dir; Expected: `exit=124`, no error lines beyond missing UI/GPIO.

- [ ] **Step 6: Commit** `git add main.js lib/portal.js test/portal-wire.test.js && git commit -m "Sub-vendos wired: poll route, vendo per phone, one payer per vendo, guards per vendo, resume script"`
