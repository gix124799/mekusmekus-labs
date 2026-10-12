# Admin pause + network watchdog (sub-project 1 of the feature batch)

Batch order agreed 2026-10-12: (1) this, (2) coin anomaly detection, (3) MAC-randomization protection,
(4) ESP8266 sub-vendo with a flashable .bin. Each gets its own spec, plan and tests.

## What already exists (not rebuilt)

- Customer pause/resume: `lib/session.js` pause/resume, `lib/money/redeem.js` pause/resume (firewall, logs,
  pauselimit). Coin rates and vouchers can already be `pausable` (`lib/money/rates.js`).
- App crash restart: procd `respawn` in `etc/init.d/vendo5`.
- Kernel hang: procd feeds the H3 hardware watchdog on OpenWrt; a frozen kernel reboots by itself.
- Coin pin and edge: set from the admin settings page (`settings.main.coinpin`, `edge`); `config/vendo.json`
  only seeds the first default.

## 1. Admin pause/resume (#6)

`@nav-22313` (`lib/wire/nav.js`) today always answers `Error`. It becomes a toggle for the client row it is
sent (`resolveMac(payload)`):

- paused session -> `money.resume(mac)`
- live session -> `money.adminPause(mac)`
- reply `'Success'` or `'Error'` like the other session actions; one mainlog line.

`adminPause` is the admin override: it pauses any live session, `consumable` included, and does not spend the
customer's `pauselimit`. It goes through a new `sessions.pause(mac, now, { force: true })` option so the
freeze logic stays in one place. Firewall failure restores the session, as `pause` does today.

## 2. Network watchdog (#10)

New `lib/system/watchdog.js`, `createWatchdog({ exec, linkExists, sessions, firewall, notifications, mainlog,
now })` (`exec(argv) -> Promise`, rejects on failure), with a `tick()` that `main.js` calls every 30 s (setInterval, `.unref()`, try/catch
like the shaper).

**WAN check.** `ping` 1.1.1.1 then 8.8.8.8 (one packet, 2 s timeout each, argv not shell), then an HTTP check
(`wget --spider` generate_204), since some ISPs drop ICMP. Down = all three fail. Time is frozen from the
first failed check, not the third.

| Consecutive failed ticks | Action |
|---|---|
| 3 (about 90 s) | mark outage, freeze client time, `ifup wan`, mainlog line |
| every further 10 min down | `ifup wan` again, one bell notification "Internet down since HH:MM" |
| first success after outage | thaw client time, notification "Internet back, down N min, time returned to M clients" |

**Client time freeze (answer A).** Outage start -> `sessions.freeze(now)`; every successful tick ->
`sessions.thaw(now)` (a no-op when nothing is frozen, so it also heals after a restart).

- `freeze` turns every live, not-paused session into a paused one marked `outage: true` (`remainingMs`
  computed as in pause). Paused sessions are never expired, persist in `sessions.json` as they are, and the
  portal already shows them as "Paused" with a frozen countdown. `pauselimit` is not touched.
- `thaw` resumes only `outage` sessions and returns their MACs; the watchdog calls `firewall.allow` for each
  (idempotent nft add), because boot-time `syncFromSessions` skips paused sessions.
- Freeze revokes each frozen client (like a customer pause), so a wrongly detected outage never gives free,
  unmetered access; thaw re-allows them.
- Restart during an outage needs no extra state file: the `outage` sessions are on disk, and the first
  successful ping after start thaws them.
- A frozen session cannot be resumed by hand (portal or admin): "No internet right now, your time is saved".
- shortcut: a brand-new session started during an outage (coins inserted while offline) is not frozen;
  freeze it too if that happens in practice.
- Voucher `validityEnd` is calendar time and still applies.

**No blocking commands.** `ping` and the recovery commands run with async `execFile`, never the sync
`runCommand`: a blocked event loop would delay coin-pulse reads (`lib/gpio.js`) and lose coins.

**LAN check.** `br-lan` missing (USB LAN adapter pulled): run `/etc/vendo5-netdetect.sh` then `ifup lan`,
once per 5 min while missing, with one bell notification per incident.

**Heartbeat.** `watchdog.status()` -> `{ wanUp, lastOkAt, outageSince, recoveries }`, written to mainlog on
each state change (not every tick).

**Not done:** automatic full reboot on WAN loss (an ISP outage would make the box reboot-loop); the hardware
watchdog already covers real hangs.

**Development machine.** Without `ubus`/`ifup` (laptop), recovery commands are skipped and logged; the
freeze/thaw logic still runs so it can be tried by pulling the laptop's network.

## Testing

- `test/session.test.js`: forced pause of a consumable session keeps `pauselimit`; freeze pauses live
  sessions with `outage: true` and they survive `expireDue`; thaw resumes only those, not customer pauses.
- `test/watchdog.test.js` with fake `exec`/clock: 2 failures do nothing; 3rd freezes and runs `ifup wan`;
  recovery thaws, re-allows the MACs and notifies once; `br-lan` missing runs netdetect then `ifup lan`;
  a fresh watchdog whose first ping succeeds thaws `outage` sessions left from before a restart.
- `test/wire-nav.test.js`: `@nav-22313` pauses then resumes a row, firewall revoke/allow
  called.
