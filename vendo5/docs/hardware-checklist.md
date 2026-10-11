# Orange Pi One hardware checklist

Everything below ran only on a development machine (no ubus, fake GPIO, no-op firewall). These are the things that
only real hardware can prove. Tick each one; note the result and the date.

Tests already passing without hardware: `npm test` (336) and `python3 scripts/live-test.py` (90 checks).

## 0. Before you start
- [ ] Pi reachable by SSH (`ssh root@<ip>`) and the web UI loads from a phone on its Wi-Fi.
- [ ] Back up the current `/mnt/wifi5` data: `tar czf /tmp/wifi5-backup.tgz /mnt/wifi5`, and copy it off the Pi.
- [ ] Note the wiring: coin acceptor signal on GPIO pin `coin_pin` (default 17, `config/vendo.json`; the Settings page
      can change it), its value per pulse, and the level (rising or falling edge).

## 1. Install
- [ ] Build: `node scripts/make-update` (update archive) or the image commands in `scripts/image-commands.js`.
- [ ] Install through Admin > 3-dots > Software update, or copy to `/opt/vendo5`. `VENDO5_SUPERVISED=1` must be set
      by procd, or the update and restart buttons refuse.
- [ ] Service starts at boot and respawns after `kill`. `logread | grep vendo5` shows `portal listening`, no `error`.
- [ ] Admin login works (`/admin`, factory admin/admin, then change it). Dashboard shows real uptime, memory, load.

## 2. Coin input (GPIO)
- [ ] The pin exports: `ls /sys/class/gpio/gpio17`. A log line `coin gpio unavailable` means it failed.
- [ ] One physical coin gives exactly ONE credit. (Fixed in the watcher for the fake sysfs file; on real sysfs the
      kernel raises one event per edge. Insert 10 coins one at a time and count.)
- [ ] Multi-pulse coins (a 5 or 10 peso coin) give the right total.
- [ ] Wrong edge setting (Settings > rising/falling/both) behaves: no double or missed counts.
- [ ] Portal: Insert Coin popup opens, each coin updates the credit live, Close closes it, countdown ends it,
      Connect turns the wallet into time at the rate table.
- [ ] A coin with no popup open still gives time the old way (no orphan: check the log for `orphan coin pulse`).
- [ ] Another phone cannot steal the slot while one is inserting ("Vendo is busy").
- [ ] Relay / LED / bill acceptor pins (Settings > Pins) switch the right outputs.

## 3. Firewall (nftables)
- [ ] A phone with no session has no internet; the portal page opens at any URL (captive portal redirect).
- [ ] After a coin or voucher the phone gets internet. `nft list ruleset` shows its MAC allowed.
- [ ] When time runs out the MAC is revoked within a few seconds, and internet stops.
- [ ] Pause revokes immediately; resume allows again; remaining time is kept.
- [ ] After a reboot, running sessions are restored and allowed again; paused ones are not.
- [ ] Whitelist and block list (Devices page) really allow / drop the MAC.
- [ ] Walled garden: hosts allowed without a session are reachable, others are not.

## 4. Network pages (real ubus/uci)
These use an emulated uci on a development machine. On the Pi they must use the real `ubus call uci`.
- [ ] Interfaces: list matches `ip addr`; editing the LAN address applies and the page still loads afterward.
- [ ] DHCP and leases: leases list matches `/tmp/dhcp.leases`; static lease works.
- [ ] Wireless: SSID/password change applies; clients reconnect.
- [ ] NFT lists, port forward, NTP client, scheduler (cron entries appear in `/etc/crontabs/root`).
- [ ] WAN modes (DHCP/static/PPPoE) switch without locking you out. Keep a console or a way back.
- [ ] Dashboard WAN graph follows real traffic (the development machine uses simulated numbers).

## 5. PPPoE server
- [ ] `/etc/ppp/chap-secrets` is written from the PPPoE accounts page.
- [ ] A PPPoE client can connect; ip-up/ip-down hooks create and remove its session record.
- [ ] Billing and expiry sweep disconnect an expired account.
- [ ] Per-account speed limits are applied (PPPoE sessions are not in the `bwlimit` chain; only the ppp hook limits them).

## 6. Sessions, limits, vouchers
- [ ] Voucher login, extend, credit code into wallet, free trial (once per device), redeem points, spin wheel.
- [ ] Upload/download limits on a voucher (nft policing in the `bwlimit` chain): a phone on a 1M voucher downloads at about 125 KB/s,
      uploads likewise; `nft list chain inet vendo5 bwlimit` shows its rules; they disappear on pause/expiry.
      (Already proven in a private namespace: `unshare -Urn bash scripts/shaper-netns-test.sh`. Real Wi-Fi/DHCP not yet.)
- [ ] Data cap (e.g. voucher `500M`): usage shows on the portal and the vouchers page; the session ends at the cap.
- [ ] Reseller portal (`/reseller`) generates vouchers that a phone can use.
- [ ] Chat: portal message reaches admin; admin reply and auto-reply reach the phone.
- [ ] Both portal themes (default and React `newTheme`) load on a real phone browser.

## 7. System
- [ ] Backup export, then import on a fresh install, restores vouchers, sales, settings, sessions.
- [ ] Software update from an uploaded archive installs, restarts and the version changes.
- [ ] Reboot and power-cycle: data survives (state is under `/mnt/wifi5`, which must be a real, mounted, writable disk).
- [ ] Media page lists a USB disk mounted under `/mnt`; play and view counts work.
- [ ] Memory and CPU stay reasonable over a day (Orange Pi One has 512 MB); the process never grows without bound.
- [ ] 24-hour soak: coins, vouchers, pause/resume, several phones at once, no errors in `logread`.

## Known gaps to expect
- Speed limits are packet policing (excess dropped), not queue shaping; PPPoE accounts' own limits still go only through the ppp hook.
- E-load, online payment, phone rental and the vendor cloud are intentionally offline (pages open, purchases refused).
- Phone-rental page swallows two JavaScript errors in its own code (cloud-only, nothing visible).
- Trial, redeem-item and spin reply fields were inferred from obfuscated scripts; check them against real use.
- `fs.watch` on sysfs may miss very short pulses; if hardware tests miss coins, switch the watcher to epoll
  (noted in `lib/gpio.js`).
