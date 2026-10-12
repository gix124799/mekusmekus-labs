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

New `lib/system/watchdog.js`, `createWatchdog({ ping, runCommand, linkExists, sessions, notifications,
mainlog, file, now })`, with a `tick()` that `main.js` calls every 30 s (setInterval, `.unref()`, try/catch
like the shaper).

**WAN check.** `ping` 1.1.1.1 then 8.8.8.8 (one packet, 2 s timeout each, argv not shell). Down = both fail.

| Consecutive failed ticks | Action |
|---|---|
| 3 (about 90 s) | mark outage, freeze client time, `ifup wan`, mainlog line |
| every further 10 min down | `ifup wan` again, one bell notification "Internet down since HH:MM" |
| first success after outage | thaw client time, notification "Internet back, down N min, time returned to M clients" |

**Client time freeze (answer A).** On outage start the watchdog calls `sessions.freeze(now)`; on recovery
`sessions.thaw(now)`.

- `freeze` records `frozenSince`. While frozen, `expireDue` returns nothing (no one runs out during the
  outage).
- `thaw` adds `now - frozenSince` to `expiresAt` of every session that is not paused (paused sessions already
  keep `remainingMs`), then clears `frozenSince`. Voucher `validityEnd` is calendar time and is not moved.
- Firewall is not touched: clients stay allowed, there is just no internet behind it.
- `frozenSince` is persisted in `file` (`state/watchdog.json`) so an app restart during an outage still gives
  the time back. On start, a stored `frozenSince` means: still frozen until the next successful ping.
- shortcut: portal countdown keeps ticking on screen during an outage (display only, the time is returned on
  thaw); fix the portal reply if customers complain.

**LAN check.** `br-lan` missing (USB LAN adapter pulled): run `/etc/vendo5-netdetect.sh` then `ifup lan`,
once per 5 min while missing, with one bell notification per incident.

**Heartbeat.** `watchdog.status()` -> `{ wanUp, lastOkAt, outageSince, recoveries }`, written to mainlog on
each state change (not every tick).

**Not done:** automatic full reboot on WAN loss (an ISP outage would make the box reboot-loop); the hardware
watchdog already covers real hangs.

**Development machine.** Without `ubus`/`ifup` (laptop), recovery commands are skipped and logged; the
freeze/thaw logic still runs so it can be tried by pulling the laptop's network.

## Testing

- `test/session.test.js`: forced pause of a consumable session keeps `pauselimit`; freeze stops expiry;
  thaw extends `expiresAt` by the outage length and leaves paused sessions alone.
- `test/watchdog.test.js` with fake `ping`/`runCommand`/clock: 2 failures do nothing; 3rd freezes and runs
  `ifup wan`; recovery thaws and notifies once; `br-lan` missing runs netdetect then `ifup lan`;
  persisted `frozenSince` survives a new watchdog instance.
- `test/wire-nav.test.js`: `@nav-22313` pauses then resumes a row, firewall revoke/allow
  called.
