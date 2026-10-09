# Sub-project #2: Offline Vendo & Captive Portal

Status: draft, pending review
Project: MekusMekus Labs — vendo5 (replacement app for WiFi5-Soft `/soft`)
Part of: full vendo/hotspot/PPPoE firmware app rebuild
Depends on: Sub-project #1 — App Skeleton & Platform Services
  (`docs/superpowers/specs/2026-10-09-app-skeleton-design.md`)

## Purpose

Turn coins into internet access, fully offline. A client plugs into the
LAN, gets redirected to a landing page, inserts a coin into the slot
wired to the device's GPIO coin pin, and gets granted internet access for
a time proportional to the coin's value. No license check, no cloud
dependency, no eLoad — those are deferred to later sub-projects once this
is stable.

Target device: Orange Pi One, same OpenWrt/Node 20 base as sub-project #1.
Builds directly on its skeleton (`lib/config.js`, `lib/gpio.js`,
`lib/logger.js`, `main.js`).

## Scope

In scope:
- Coin-pulse → credit conversion, configurable rate
- Per-client session tracking (MAC-keyed), with top-ups extending the
  current session
- Firewall-rule-based access enforcement (nft/iptables), one rule per MAC
- A minimal captive-portal HTTP server: landing page + status/pay-intent
  API
- Session persistence across reboot, with firewall rules re-applied at
  boot for sessions still valid
- Orphaned-coin-pulse handling (no client identified) — refuse to credit,
  log a warning

Out of scope (future sub-projects): PPPoE/RADIUS, admin dashboard,
reseller, licensing (any form), payment methods other than the coin
slot, eLoad, any cloud/remote service call.

## Architecture

Single Node process (same `main.js` entrypoint as sub-project #1),
internally layered into independently testable modules — no physical
split into multiple services. One port (3000, matching the reference
WiFi5-Soft nginx config's `upstream backend`), one procd service.

```
main.js
  → config.loadConfig()          [sub-project #1]
  → gpio.createGpio()             [sub-project #1]
  → logger.log()                  [sub-project #1]
  → session.createSessionStore()  [new]
  → firewall.createFirewall()     [new]
  → arp.createArp()               [new]
  → portal.createServer()         [new]
```

## Components

### `lib/session.js`

Pure session bookkeeping; the one side effect is writing/reading its
persistence file (path injected, no hardcoded `/mnt/...` inside the
module — same injectable-path convention as `lib/gpio.js`'s `base`).

- `createSessionStore(filePath)` → `{ load(), save(), addCredit(mac,
  pesos, ratePesosPerMinute), getSession(mac), isActive(mac, now),
  expireDue(now) }`
- Session shape: `{ mac, creditPesos, expiresAt }` (epoch ms).
- `addCredit(mac, pesos, ratePesosPerMinute)`: if no session exists for
  `mac`, creates one with `expiresAt = now + pesos/ratePesosPerMinute *
  60000`. If one exists and is still active, **extends** `expiresAt` by
  the new credit's minutes (top-up, confirmed design decision — never
  queues a second session). If one exists but already expired, treated
  as a fresh session starting now.
- `expireDue(now)`: returns the list of MACs whose `expiresAt <= now` and
  removes them from the active set (caller is responsible for revoking
  their firewall rule).
- `load()` at startup: reads the JSON file, drops any session already
  expired (no point re-applying a firewall rule for it), keeps the rest.
  Missing or corrupt file → log a warning, start with an empty store (do
  not crash-loop; do not trust unreadable state).
- `save()`: called after every mutating call (`addCredit`, an
  `expireDue` sweep) — whole-store overwrite, small enough (one row per
  active client) that this is simpler and safer than incremental writes.

### `lib/firewall.js`

Shells out to add/remove one rule per MAC in a dedicated vendo5 chain.
Exact `nft`/`iptables` invocation is an implementation-plan-level detail;
this spec fixes the interface and failure behavior.

- `createFirewall(runCommand)` → `{ allow(mac), revoke(mac),
  syncFromSessions(sessions) }` — `runCommand` is injected (same pattern
  as `gpio.js`'s injectable `fs`) so tests never shell out for real.
- `allow`/`revoke` are idempotent: allowing an already-allowed MAC, or
  revoking an already-absent one, is not an error.
- A thrown error from the underlying command is caught by the caller
  (`main.js`), logged at `error`, and does **not** mutate session state —
  a session that should be firewalled but isn't gets retried on the next
  coin/expiry event rather than silently lost or silently marked done.
- `syncFromSessions(sessions)`: called once at boot with the sessions
  `session.load()` kept. Applies `allow` per MAC. A failure on one MAC is
  logged and does not stop the sync loop for the rest.

### `lib/arp.js`

Resolves a client's source IP to a MAC via the LAN's ARP/neighbor table.
Read-only, separated from `firewall.js` (which only writes) so each can
be faked independently in tests.

- `createArp(runCommand)` → `{ ipToMac(ip) }`, shells out to `ip neigh
  show <ip>` (or equivalent), parses the MAC out of the output.
- No entry found (new client, expired ARP cache) → returns `null`. The
  caller (`portal.js`) treats `null` as unpaid — fail toward "ask them to
  pay", never toward granting access to an unidentified client.

### `lib/portal.js`

Minimal HTTP server using `node:http` directly — no framework dependency
for a landing page and two small JSON endpoints.

- `createServer({ session, firewall, arp, ratePesosPerMinute })` →
  `http.Server`.
- `GET /` (or any unmatched host/path — captive-portal catch-all): looks
  up the requester's MAC via `arp.ipToMac(req socket's remote IP)`. If
  `session.isActive(mac)`, this path is barely reached in practice (the
  firewall rule already lets paid clients straight through to the real
  internet) — but when it is reached (e.g. client hits the portal's own
  IP directly), serves a simple "you're online, N minutes left" page.
  Otherwise serves the landing page ("insert coin to continue").
- `POST /api/pay-intent`: called by the landing page when the user is
  about to insert a coin. Looks up the caller's MAC and records it as the
  pending payer with a short TTL (a few seconds — just long enough to
  cover the gap between the page call and the physical coin drop).
  Response: `{ ok: true }`.
- `GET /api/status`: returns `{ active: bool, remainingSeconds }` for the
  caller's MAC, for the landing page to poll and update its own display.

### `main.js` additions (on top of sub-project #1)

- At boot, after `config.loadConfig()`: construct `session`, `firewall`,
  `arp`, `portal` with the config's `vendo` section (`coin_pin`,
  `pulse_value_pesos`, `pesos_per_minute`) and a session file path under
  the config directory's parent (e.g. sibling `vendo5-sessions.json` on
  `/mnt/wifi5`, so it survives reboot on the same durable partition the
  config itself lives on).
- `session.load()` → `firewall.syncFromSessions(...)` → `portal`
  `.listen(3000)` → `gpio.watchPin(coin_pin, 'in', 'rising', onPulse)` →
  `setInterval(checkExpiry, 1000)`.
- `onPulse()`: debounces multiple pulses from one physical coin into a
  single coin event (debounce window is a config/implementation detail,
  not fixed by this spec — sub-project #1's gpio.js note on sysfs
  latency applies here too). Looks up the pending payer set by the last
  `/api/pay-intent` call within its TTL.
  - **Payer found:** `session.addCredit(mac, pulse_value_pesos,
    pesos_per_minute)` → `firewall.allow(mac)` → `session.save()`.
  - **No pending payer (TTL expired, none set):** log a `warn` with the
    pulse timestamp. No credit applied, no firewall change. This is the
    confirmed behavior for orphaned pulses — refuse and log, never guess
    the payer.
- `checkExpiry()`: `session.expireDue(now)` → for each returned MAC,
  `firewall.revoke(mac)`, then `session.save()`. The client's next HTTP
  request now falls through to the portal's landing page (the firewall
  no longer lets them past it).

## Data flow

```
Boot:
  main.js → session.load() (drops already-expired)
          → firewall.syncFromSessions(remaining sessions)
          → portal.listen(3000)
          → gpio.watchPin(coin_pin, ...)
          → setInterval(checkExpiry, 1000)

Client connects, unpaid:
  HTTP request → portal: arp.ipToMac(ip) → session.isActive? no
               → serve landing page

Client taps "insert coin now" on landing page:
  POST /api/pay-intent → portal: arp.ipToMac(ip) → set pending payer (mac, TTL)

Coin dropped:
  GPIO pulse → main.js onPulse() → debounce → pending payer within TTL?
    yes → session.addCredit(mac, pulse_value_pesos, pesos_per_minute)
        → firewall.allow(mac)  (idempotent; also the path for top-ups)
        → session.save()
    no  → log warn, no credit, no firewall change

Paid client browses:
  firewall already allows mac → traffic passes straight to the internet,
  portal is not in the path (no redirect, no slowdown)

Session expires:
  checkExpiry() sweep → session.expireDue(now) → firewall.revoke(mac)
                       → session.save()
  → client's next request has no firewall rule → redirected to landing page
```

## Error handling

- **Firewall command fails:** caught in `main.js`, logged at `error`,
  session state unchanged — retried on the next coin/expiry event.
- **`syncFromSessions` partial failure at boot:** per-MAC failures
  logged; does not block startup or the rest of the sync.
- **ARP lookup fails (`null` MAC):** portal treats as unpaid; never
  grants access to an unidentified client.
- **Orphaned coin pulse:** logged at `warn`, no credit, no crash — see
  above.
- **Session file corrupt or missing at boot:** logged at `warn`, start
  with an empty session store (same fail-loud-but-don't-crash-loop
  posture as sub-project #1's config loader, applied to session state:
  here "fail loud" means log and continue empty, not throw, since an
  empty session store is itself a safe, valid state — unlike a missing
  required config key).
- **Config missing pricing fields:** `lib/config.js`'s `REQUIRED` map
  (sub-project #1) extends `vendo` to require `pulse_value_pesos` and
  `pesos_per_minute` alongside the existing `coin_pin` — missing either
  throws at startup, same as today.

## Testing

No hardware required, following sub-project #1's injectable-path pattern:

- `session.js`: unit tests against a temp file — credit math, top-up
  extension of an active session, fresh session after expiry, the
  `expireDue` sweep, and a save→reload round trip that preserves state.
- `firewall.js`: unit tests with a fake `runCommand` — asserts the right
  calls happen for `allow`/`revoke`/`syncFromSessions`, idempotency on
  repeat calls, and that a thrown command error doesn't touch session
  state (caller's responsibility, verified at the `main.js` integration
  level).
- `arp.js`: unit tests with a fake `runCommand` and fixture `ip neigh`
  output, including the "no entry" → `null` case.
- `portal.js`: tests spin up the real `http.Server` on an ephemeral port
  with fake `session`/`firewall`/`arp` injected — landing page for
  unpaid, `/api/pay-intent` sets the pending payer, `/api/status`
  reflects remaining time.
- `main.js` integration smoke test (extends sub-project #1's): fixture
  config + fake GPIO sysfs dir, simulate a coin pulse, assert a
  firewall-allow call happened and the session file was written; a
  second test simulates a pulse with no prior pay-intent and asserts a
  `warn` log line with no firewall call.

## Open questions for review

None outstanding — all surfaced during design were resolved: access
enforcement mechanism (firewall rule per MAC), pricing (configurable),
top-up behavior (extends current session), persistence (sessions +
remaining time survive reboot), client identity (MAC via ARP), expiry UX
(redirect to landing page), and orphaned-pulse handling (refuse + log).
Exact debounce window and firewall tool (`nft` vs `iptables`, whichever
OpenWrt ships by default on this image) are implementation-plan-level
details, not spec-level ambiguities.
