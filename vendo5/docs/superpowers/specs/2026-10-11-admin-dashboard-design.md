# Sub-project #5: Admin Dashboard — Live Logs & Session Actions

Status: draft, pending review
Project: MekusMekus Labs — vendo5 (replacement app for WiFi5-Soft `/soft`)
Depends on: Sub-project #2 — Offline Vendo & Captive Portal
  (`docs/superpowers/specs/2026-10-09-vendo-portal-design.md`), which built the
  current `/admin` login + read-only, no-refresh session table.

## Purpose

The current `/admin` page (sub-project #2) shows a static, one-shot render of
active sessions and nothing else. This sub-project closes the specific gap
named in sub-project #3's own "out of scope" note — "admin dashboard beyond
login+session view" — with three pieces: a live log viewer, the ability to
manually revoke a session or grant comp credit, and auto-refresh so the admin
doesn't have to reload the page to see any of it.

No new runtime dependency, no new process, no router library — extends the
existing `node:http`-only, hand-rolled-route style already in `lib/portal.js`.

## Scope

In scope:
- A ring-buffer log viewer: the last 500 log lines, in memory, visible on
  `/admin`.
- Two manual session actions: revoke a session now, and grant comp credit to
  a MAC already shown in the session table (no free-text MAC entry).
- Every manual action writes an audit log line, visible in the same log
  viewer.
- Client-side polling (2s) so the session table and log panel update without
  a page reload.

Out of scope (unchanged from prior specs, not reopened here): vouchers,
credit codes, PPPoE/RADIUS/billing, reseller accounts, licensing, any
cloud/remote call. Persisting logs to disk across a restart — the ring
buffer is memory-only; see "Known limitation" below.

## Architecture

```
lib/logger.js   -- unchanged log() signature; adds an in-memory ring buffer
                   and getRecent()
lib/session.js  -- adds revoke(mac); existing addCredit/all/isActive/etc
                   unchanged
lib/portal.js   -- createServer() gains `firewall` as a new injected
                   dependency; adds 3 admin-only routes; dashboard HTML/JS
                   gains polling
main.js         -- one-line change: pass `firewall` into createServer(...)
```

## Components

### `lib/logger.js`

- `log(level, message, fields)`: **signature and behavior unchanged** — still
  writes to `out` (default `process.stdout`) exactly as today. Additionally
  pushes the same `{...fields, ts, level, message}` object onto a
  module-level array, trimming the oldest entry once length exceeds
  `CAPACITY = 500`. A module-level buffer is consistent with `lib/config.js`'s
  existing `loaded` singleton — not a new pattern in this codebase.
- New export: `getRecent()` → returns a shallow copy of the full buffer (up
  to 500 entries), newest last. No timestamp-filtering parameter — the
  dashboard re-fetches and re-renders the whole buffer on each poll.
  `shortcut: re-sends up to ~500 JSON lines every 2s poll instead of only
  new lines since last fetch; fine at this log volume and polling interval,
  revisit with a "since" cursor if the buffer grows or the interval shrinks.`

### `lib/session.js`

- New: `revoke(mac)` → `delete sessions[mac]`, returns `true` if a session
  existed and was removed, `false` otherwise. Pure in-memory mutation, same
  as `addCredit`/`expireDue` — caller is responsible for calling `save()`
  afterward. Does not touch the firewall; that boundary stays in the caller,
  matching this module's existing "pure bookkeeping" scope.

### `lib/portal.js`

- `createServer({ session, firewall, arp, ratePesosPerMinute, adminAuth })` —
  `firewall` is a new required dependency (previously only `main.js`'s own
  expiry loop held a reference to it).
- `GET /admin/api/logs` (admin-only, 401 if not `isAdminSession()`): responds
  `getRecent()` as JSON.
- `POST /admin/api/sessions/:mac/revoke` (admin-only): mac taken from the URL
  path, matched via the same hand-rolled regex style as existing routes
  (`/^\/admin\/api\/sessions\/([0-9a-fA-F:]+)\/revoke$/`). 404 if that MAC has
  no active session. See "Error handling" for the exact ordering.
- `POST /admin/api/sessions/:mac/credit` (admin-only), body `{ pesos }`: 404
  if the MAC isn't in `session.all()` (per the scope decision: existing rows
  only, no free-text MAC); 400 if `pesos` isn't a positive finite number. See
  "Error handling" for ordering.
- Dashboard HTML (`dashboardContent`) gains a log panel (`<pre>` or similar,
  scrollable) and, per session row, a "Revoke" button and a small
  amount-input + "Add credit" button. Dashboard JS adds
  `setInterval(refresh, 2000)` that re-fetches `/admin/api/sessions` and
  `/admin/api/logs` and re-renders both in place (no full page reload).

### `main.js`

- One-line change: `createServer({ session, firewall, arp, ratePesosPerMinute: pesos_per_minute, adminAuth })` — thread the already-constructed `firewall` instance through.

## Data flow

```
Admin clicks "Revoke" on a row:
  POST /admin/api/sessions/<mac>/revoke
    → firewall.revoke(mac)        (tried FIRST, see Error handling)
      success → session.revoke(mac) → session.save()
              → log('info', 'admin revoke', { action: 'revoke', mac, admin: true })
              → 200 { ok: true }
      throws  → log('error', 'admin revoke failed', { action: 'revoke', mac, admin: true, error })
              → session state untouched
              → 500 { ok: false }

Admin clicks "Add credit" on a row (amount N):
  POST /admin/api/sessions/<mac>/credit { pesos: N }
    → 404 if mac not in session.all()
    → 400 if N is not a positive number
    → session.addCredit(mac, N, ratePesosPerMinute)   (always first)
    → try { firewall.allow(mac) }
      catch (e) { log('error', 'admin credit: firewall allow failed', { action: 'credit', mac, pesos: N, admin: true, error }) }
        (credit is NOT rolled back on this failure -- see Known limitation)
    → session.save()
    → log('info', 'admin credit', { action: 'credit', mac, pesos: N, admin: true })
    → 200 { ok: true }

Dashboard auto-refresh (every 2s, while /admin is open and logged in):
  GET /admin/api/sessions -> re-render session table
  GET /admin/api/logs     -> re-render log panel
```

## Error handling

- **Revoke, firewall call fails:** session state is left untouched (the
  session stays active). This is the one place this spec deliberately
  reorders from the "mutate app state first, firewall second" pattern used
  everywhere else in this codebase (coin pulse, comp-credit, boot sync).
  Reason: marking a session "ended" while the firewall still grants access
  would make the dashboard lie about what the customer can actually do, and
  — unlike a natural expiry, which gets re-swept every second by
  `checkExpiry()` — nothing re-attempts an admin-initiated revoke on its
  own. Surfacing the failure to the admin (who can just click Revoke again)
  is an acceptable manual-retry path for an action a human is actively
  watching; an unattended background loop is not available here the way it
  is for natural expiry.
- **Comp-credit, firewall call fails:** credit is kept, the failure is only
  logged — this exactly mirrors the existing real-coin-pulse behavior in
  `onPulse()` (sub-project #2), which already has the same latent gap (if
  `firewall.allow()` throws, credit is granted but access isn't, and
  nothing retries it, since `checkExpiry()` only ever revokes). This spec
  does not fix that pre-existing gap; flagging it here so it's visible
  rather than silently inherited. If you want it fixed, it should be fixed
  once for both call sites, not specially for the new one.
- **Revoke/credit on an unknown MAC:** 404, no session/firewall call made.
- **Invalid `pesos` (non-number, zero, negative, NaN):** 400, no session/
  firewall call made.
- **Unauthenticated request to any new admin route:** 401, same as the
  existing `/admin/api/sessions` route.

## Known limitation

The log ring buffer is memory-only and is lost on restart or crash — by
design, per the earlier decision to avoid new disk/flash wear and a
rotation policy for this increment. It is a live-tail/audit-trail view, not
a durable log. If post-mortem debugging across restarts becomes a real
need, that is a separate future increment (an append-only capped file, as
considered and deferred during this design's scoping).

## Testing

Following this repo's existing injectable-dependency convention (no
hardware, no real shelling out, no real sockets beyond an ephemeral test
port):

- `logger.js`: unit tests for `getRecent()` — returns pushed entries in
  order, caps at 500 and drops the oldest first, independent from what
  `log()` writes to `out`.
- `session.js`: unit tests for `revoke()` — removes an existing session and
  returns `true`; returns `false` and is a no-op for an unknown MAC; does
  not call `save()` itself (caller's responsibility, matching
  `addCredit`/`expireDue`).
- `portal.js`: tests with fake `session`/`firewall`/`arp`/`adminAuth`
  injected (extends the existing pattern):
  - revoke: success path calls `firewall.revoke` then `session.revoke` then
    `session.save`, in that order; firewall-throws path does **not** call
    `session.revoke`/`save`, logs at `error`, responds non-200.
  - credit: success path calls `session.addCredit` before
    `firewall.allow`; firewall-throws path still keeps the credit (asserts
    `session.addCredit` was called) and still responds 200, logs at
    `error`.
  - 404 for an unknown MAC on either route; 400 for invalid `pesos`.
  - 401 for any of the 3 new routes without a valid admin session cookie.
  - `/admin/api/logs` returns whatever the fake logger's `getRecent()`
    returns, verbatim.

## Open questions for review

None outstanding. Scope (which three pieces), log durability (ring buffer,
memory-only), comp-credit's MAC restriction (existing rows only), and
audit-logging of manual actions (always) were all resolved during
brainstorming. The one design decision made without an explicit prior
answer — the revoke/credit ordering asymmetry — is justified above; flag it
in review if it should go the other way.
