# Sub-vendos: ESP8266 coin boxes, one VLAN each, time that follows the customer (sub-project 4)

Decisions (2026-10-12): every sub-vendo is its own WiFi AP on a managed switch, tagged with its own VLAN; the
ESP8266 is a NodeMCU / Wemos D1 Mini with a CH-926 multi-coin acceptor (COIN signal) and a relay powering it;
sub-vendos use the main vendo's rate table; SSIDs may differ per AP; time follows the phone automatically when
the browser keeps its storage, with the resume code as the fallback; only one device at a time may insert coins
at a given vendo.

Built as three plans, in this order: **5a** main-side multi-vendo, **5b** VLANs, **5c** ESP8266 firmware + .bin.

## Facts that shape the design

- All sessions live on the main Orange Pi, keyed by MAC; every AP only bridges its VLAN to it. Moving between
  vendos therefore keeps the time whenever the phone keeps its MAC.
- Android 10+ and iOS 14+ use a different random MAC per SSID. With different SSIDs the main sees a different
  device; nothing on the network side can link them. Hence the browser token + resume code.
- The original admin Settings page already has a sub-vendo section (`vendoInfo.sub`, `vendoOnline`, an
  activation `request` list, `@nav-14433211` activate, `edit-name-sub-vendo`, a 14-character `key`). Today these
  are offline stubs. 5a fills them; the exact shapes the page reads are recovered from
  `legacy/wifi5-soft/frontend-decrypted/public/nav/script/settings.js` as the first 5a task (the string table
  is base64 and the code is obfuscated; the request/activation fields are not known yet).
- No original sub-vendo protocol or firmware was recovered; the protocol below is ours.

## 5a. Main side

**Vendo registry.** `settings.main` stays the main vendo. Sub-vendos live in `settings.sub[<id>]`:
`{ id, name, description, countdownMax, coinsBlockerDelay, relaypinactive, iface, chipId, activated }`.
They share `settings.main.config` (rates). `id` is `sub1`, `sub2`, ... in activation order.

**Which vendo a phone is at.** `arp.neighbors()[mac].dev` gives the interface; `br-lan` is `main`, the
interface a sub-vendo's own requests come from is that sub-vendo (`iface`, learned at activation). A phone on an
interface with no vendo is treated as `main`.

**One device per vendo at a time.** The single pending-payer slot in `lib/portal.js` becomes one slot per vendo
(`Map vendoId -> { mac, at, ttl }`). Insert Coin (`listenCoin`) on a vendo whose slot another phone holds
answers `Vendo is busy, someone else is inserting coins`, as today; other vendos are unaffected. The slot is
freed when that phone's countdown ends or it presses Done/Close (`stopCoin`), as today for main.

**Portal vendo list.** `@portal-14` returns only the vendo the phone is at, so the page needs no choice.

**Coins from a sub-vendo.** Each vendo has its own coin guard (`lib/coinguard.js`). The ESP counts pulses
itself (interrupts, exact timing) and sends whole trains; the guard gets a new entry point
`train(count, minGapMs)` that applies the same rules (too fast, too many pulses, orphan, lockout) as the GPIO
path. Credits go through the same code path as main coins (wallet while the popup is open, else time), with
`vendo` added to the sales record.

**Sub-vendo API** (on the portal server, reachable from every VLAN before login):
`POST /subvendo/poll`, JSON body `{ chip, nonce, events, sig }`, every 500 ms from each ESP.

- `sig` = hex HMAC-SHA256 over `chip|nonce|JSON(events)` with key = HMAC-SHA256(vendo key, chip). The vendo
  key is the existing 14-character `settings.key`; the owner types it into the ESP setup page. Customers never
  see it; sniffing the open WiFi does not reveal it.
- `nonce` is the one the main gave in its previous reply (`hello` on first contact). Each nonce is accepted
  once, so a captured request cannot be replayed.
- `events`: `[{ id, pulses, minGapMs }]`, `id` counting up from 1 per ESP boot (`boot` random 32-bit sent with
  hello). The main credits each `(boot, id)` once, so resending after a lost reply never double-credits.
- Reply `{ nonce, relay, ack }`: next nonce, whether the acceptor relay should be on (a phone holds that vendo's
  slot and the slot is not locked), the highest event id credited.
- A chip that is not activated gets `{ nonce, pending: true }` and appears in the Settings page request list
  (chip id, interface, IP, first seen). Activate assigns the next `subN` id and binds the interface.
- A vendo whose ESP has not polled for 10 s is shown offline in `vendoOnline`; its slot cannot be taken
  (`Vendo is offline`).
- shortcut: replies are not signed (a forged reply can only switch the acceptor on); sign them if that matters.

**Automatic move (browser token).** A small script is added to every portal page (same mechanism as the Themes
script, before it). On load and every 30 s it posts the resume code it has in `localStorage` to
`POST /api/resume` and stores the code the reply gives back. The server: if the phone (by IP -> MAC) has no
live session and the code belongs to a live session on another MAC, it moves it exactly like the voucher-box
resume (`money.moveSession`, wrong codes count toward the lock); it replies with the phone's current resume code
(or none). Where the captive-portal popup keeps no storage, the Logs-page resume code remains the way back.

## 5b. VLANs on OpenWrt

- `config/network.json` gets `vendo_vlans`, e.g. `[10, 20, 30]` (default `[]`).
- At boot (`/etc/vendo5-netdetect.sh` path, after the LAN port is known) each VLAN `v` gets an 802.1Q device on
  the LAN port, interface `vlan<v>`, address `10.<v/10>.0.1/19`, DHCP like `lan` (8190 addresses, 72 h),
  and joins the vendo5 captive-portal and firewall rules wherever `br-lan` is used today (allowed set by MAC is
  interface-independent, so a paid MAC is let through on any VLAN).
- The main AP stays untagged on `br-lan`. The switch port to the Orange Pi is a trunk (untagged main + tagged
  VLANs); each sub-vendo AP port is untagged in its VLAN, or the AP tags its SSID itself.
- Setup guide in `docs/subvendo-setup.md` (switch, AP, ESP wiring, flashing).

## 5c. ESP8266 firmware

- `firmware/subvendo/subvendo.ino`, ESP8266 Arduino core only (ESP8266WiFi, ESP8266WebServer,
  ESP8266HTTPClient, bearssl HMAC via `br_hmac`), LittleFS for settings.
- Coin input: `attachInterrupt` on the COIN pin (default D5/GPIO14, pull-up, falling edge), pulse times in
  microseconds; a train ends 300 ms after its last pulse; the event carries `pulses` and the smallest gap.
- Relay: default D6/GPIO12, active level configurable; off at boot and whenever the main says so or the main has
  not answered for 3 s.
- Status LED on the board LED: blinking = no WiFi / not activated, steady = ready.
- Setup: holding FLASH (GPIO0) 3 s at boot, or no saved WiFi, starts AP `SubVendo-<chip>` with a page at
  192.168.4.1: WiFi SSID/password, main server address (default: the gateway it gets by DHCP), vendo key,
  coin pin, relay pin, relay active level.
- Build with `arduino-cli` (esp8266 core pinned to an exact version) by `firmware/subvendo/build.sh`; the
  `.bin` is committed at `firmware/subvendo/subvendo-<version>.bin` with its SHA-256. Flash with the ESP
  Flash Download Tool or `esptool.py write_flash 0x0 subvendo-<version>.bin`.

## Testing

- 5a: unit tests for the per-vendo slots, the vendo lookup by interface, `coinguard.train`, the poll handler
  (bad signature, replayed nonce, duplicate event, pending chip, activation, offline), `/api/resume`; an e2e
  test driving `/subvendo/poll` against the real `main.js` with a fake ESP (HMAC in the test).
- 5b: generated uci/nft commands checked in unit tests; on-device checklist.
- 5c: the firmware builds in `build.sh` (CI-able); a host-side test of the signing code against the Node
  implementation (same input -> same signature); on-device checklist with a real CH-926.
