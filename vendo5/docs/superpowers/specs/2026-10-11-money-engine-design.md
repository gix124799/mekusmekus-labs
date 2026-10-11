# Sub-project #7: Money Engine, Client Sessions & Vendo Settings

Status: draft, pending review
Project: MekusMekus Labs — vendo5
Depends on: #6 Original UI Foundation (wire server, event table, pages registry, main log, state dir)
Roadmap position: #7 of #6-#12 (see #6 spec). Order agreed with the user: #7 → #12 in sequence, one spec/plan/build/live-test cycle each.

## Purpose

Make every page and button that deals with *money and clients* work, offline, against the
original frontend: Vouchers, Credit, Sales, VC Sales, Devices (clients) and Settings (the
vendo/coin machine section), plus the session model they need (session types, pause/resume,
limits) and the customer-side redemption of voucher codes, credit codes and points. This is
where #5/#6's deferred items land: free credit ("create custom session"), Disconnect
(`@nav-22313`) and real session row fields.

## Scope

In scope (pages enabled in the registry once each works): `vouchers`, `credit`, `sales`,
`vcsales`, `devices`, `settings`. Events (ids from the feature map, all guarded like #6):

| Area | Events | Behaviour |
|---|---|---|
| Vouchers | `@nav-96547` generate, `@nav-52212` save list, `@nav-536547` read sold, `@nav-536548` clear sold, `@nav-33254589` pausable rule, `@nav-55647` `@nav-12215` list/read | codes with prefix, quantity, type (pausable/consumable), validity, `max_data_limit`, price; stored in `<state>/vouchers/` |
| Credit codes | `@nav-36200` generate, `@nav-36220`/`@nav-35532` get/set config, `@nav-033214` sold, `@nav-536549` clear sold | peso-value codes that top up a session |
| Sales | `@nav-00932` get, `@nav-11220` remove/clear, `@nav-0021145` voucher+credit sales | dated records written by coin, voucher and credit redemptions |
| Client sessions | `@nav-89000` extend (exists), `@nav-43000` extend many, `@nav-43456` edit subscription, `@nav-22313` disconnect, `@nav-96549` create custom session, `@nav-33244` points/credit ops | pause/resume, limits, free credit |
| Client names / ids | `@nav-77833`, `@nav-113311` `@nav-113354` `@nav-00332145` `@nav-55332145` | names per MAC; the unique-id (`idbase`) mode is kept off |
| Settings (vendo) | `@nav-22114` `@nav-22115` `@nav-225585` `@nav-22125` `@nav-22126` `@nav-36625` `@nav-36541223` `@nav-36547111` | coin pin, relay pin, edge, rate, coin corrector, blocker delay, countdown, trial, hostname |
| Points / spin wheel | `@nav-0092734` | point system config, redeem items, spin wheel items and order |

Out of scope: resellers (#10), PPPoE (#11), network pages (#9), themes/media/tickets/chat
(#12), the customer portal's visual themes (#8). Never in scope: e-load, online payment,
phone rental, sub-vendo licence redeem (`@nav-14433211`), any vendor call.

## Decisions to confirm in review

| # | Decision | Why |
|---|---|---|
| M1 | Storage is plain JSON files under `<state>/` (vouchers, credit codes, sales, points, clients), each written atomically, like `account.json` | same as the original's `/mnt/wifi5/...` files; no database on a 512 MB device; easy to back up |
| M2 | Pause = remove the MAC from the firewall allowed set and freeze `remainingMs`; resume re-adds it and sets `expiresAt = now + remainingMs`. Only `pausable` sessions can pause | this is the paused-session state that #6 deferred; it makes Disconnect and the portal's pause button real |
| M3 | Money is integer centavos internally, displayed as pesos | avoids float drift in sales totals |
| M4 | Each redemption (coin, voucher, credit code, points, admin free credit) writes one sales record and one main-log line | the Sales pages and audit trail come from the same source |
| M5 | The single-rate `pesos_per_minute` from #2 becomes the original's rate table in Settings; `pesos_per_minute` stays the fallback when no table is set | Settings page edits the table; existing installs keep working |
| M6 | Voucher/credit codes are random, not guessable: 4-char prefix + 8 chars from a 31-symbol alphabet without look-alikes, drawn from `crypto.randomInt`; redemption is rate-limited per MAC (5 wrong codes → 5-minute lockout) | codes are money; a public portal field must not be brute-forceable |

## Architecture

New modules, same style as #6 (plain `(payload, ctx)` handlers, injected `runCommand`,
clock and stores):

```
lib/store/vouchers.js    codes: generate, list, redeem, mark sold, clear
lib/store/credits.js     credit codes, same shape
lib/store/sales.js       dated records, totals, clear by date/range
lib/store/clients.js     names per MAC, points, per-client limits
lib/store/points.js      point system and spin wheel config
lib/money/redeem.js      the one place that turns a coin/voucher/credit/points event into
                         a session change + sales record + log line (M4)
lib/money/pause.js       pause/resume against session store + firewall (M2)
lib/wire/money.js        handlers for the events above (one file per group if it grows)
```

`lib/session.js` gains `type`, `remainingMs`, `paused`, per-session limits and the voucher
`code`; the #6 dashboard adapter then reports real values instead of defaults. Persisted
sessions from #6 load unchanged (missing fields default to a consumable, unlimited session).

The customer portal gets a code field and a Pause/Resume control through the existing
`/api/*` JSON routes (`POST /api/redeem`, `POST /api/pause`, `POST /api/resume`), served by
the current simple portal page; #8 replaces that page with the original themes and reuses the
same routes.

## Contract discipline (as in #6)

The first task of the plan runs the unmodified Vouchers, Credit, Sales, VC Sales, Devices and
Settings scripts in headless Firefox with every reply wrapped in a recording `Proxy`, and
the plan's handler tasks are written to what the pages actually read. Decompiled handlers
are evidence, not proof (#6 found missing fields this way twice).

## Error handling

- A redemption is atomic: session change, sales record and log line happen together or not
  at all; a firewall failure on allow rolls the session change back and answers the original
  error text. A crash between the session file and the sales file leaves the voucher unmarked
  (the code stays usable), never a sold voucher without time.
- Unknown, used, expired or foreign-owner codes answer the original's "Invalid"/"Used"
  strings and count toward the lockout (M6).
- Generation is bounded (quantity ≤ 1000 per call) so a mistyped request cannot fill flash.
- Every file store tolerates a missing or corrupt file (starts empty, logs once).

## Testing

1. Unit: each store and `redeem.js` with fakes (clock, random, firewall): generate, redeem,
   double-redeem, expiry, lockout, pause/resume arithmetic, sales totals, atomic failure paths.
2. Wire: socket tests per event with `socket.io-client`, shapes from the recorded contract.
3. Live Firefox (extends `scripts/live-test.py`): generate vouchers, redeem one from the portal
   page, see it in Sales and on the dashboard, pause/resume, free credit, edit a session,
   Settings round-trip, spin-wheel config, and every button on these pages clicked once with
   no JavaScript error.

## Risks

- Several event payloads are only known from decompiled code; the recorder (above) is the
  mitigation, and any field the page reads but we lack fails a live check.
- The Settings page mixes pure config with commands (coin pin, relay pin, hostname). Pin and
  edge changes act on sysfs GPIO and are untestable without hardware; they are unit-tested
  against the fake sysfs and flagged for real-hardware verification (same open item as #3).
- Sub-vendo (`accept sub-vendo`, `@nav-22125` requests) is hidden: it exists only to pair
  with other vendor-licensed machines.

## Open questions for review

1. M2: is "pausable" per voucher type enough, or should every coin session be pausable?
   (Default: coin sessions are consumable, as in the original.)
2. M5: keep the rate table, or stay with one peso-per-minute rate? (Default: table.)
