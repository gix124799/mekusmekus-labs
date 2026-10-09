# Sub-project #3: Network & Firewall Provisioning

Status: implemented, pending real-hardware verification
Project: MekusMekus Labs — vendo5 (replacement app for WiFi5-Soft `/soft`)
Depends on: Sub-project #2 — Offline Vendo & Captive Portal
  (`docs/superpowers/specs/2026-10-09-vendo-portal-design.md`)

## Purpose

Sub-project #2 built `lib/firewall.js`'s runtime `allow`/`revoke`/
`syncFromSessions`, which issue `nft add/delete element` and `nft flush
set` against a table (`inet vendo5`) and set (`allowed`) that are assumed
to already exist. Nothing created them — on a fresh device every `allow`
call throws. This sub-project provisions the actual network topology and
firewall ruleset so the whole system works on real hardware, not just
against a fake `runCommand` in tests.

## Topology (owner-specified)

```
Internet ── Orange Pi One built-in Ethernet (WAN, DHCP client)
Orange Pi One USB port ── USB-to-LAN adapter (LAN, static 10.0.0.1/24,
  bridged as 'br-lan') ── Ethernet cable ── standalone access point
  (AP mode) ── Wi-Fi ── customers and admin
```

No Wi-Fi config on the device itself — the AP is a separate physical
device. Customers and admin share the same AP/subnet, distinguished only
by URL path (`/` vs `/admin`), not by network segment.

## Access policy (owner-specified)

A client connecting to the AP has **no internet** until they have active
time — whether from a coin, an already-active session, or (future) a
voucher. This must hold at the network layer, not just the app layer:
even if a client never visits the portal page at all, they must not
reach the real internet while unpaid.

## Firewall design

Standard captive-portal technique, chosen over DNS hijacking because it
needs no DNS involvement and leaves paid clients' real DNS resolution
untouched:

- `dstnat` (prerouting): any client **not** in the `allowed` set making a
  plain HTTP (port 80) request to *any* destination is DNAT'd to the
  portal app (`10.0.0.1:3000`) — works regardless of which site they
  were trying to reach, no DNS override needed.
- `forward` (default policy `drop`): LAN→WAN forwarding is only accepted
  for MACs in `allowed`. Unpaid clients' non-HTTP traffic (HTTPS, etc.)
  is simply dropped.
- `postrouting`: masquerade (NAT) only for `allowed` MACs' outbound WAN
  traffic.

**Known, inherent limitation:** an unpaid client's HTTPS attempts are
dropped, not redirected — there is no way to show the portal page over
HTTPS without a client-trusted certificate (true of every captive
portal, not specific to this implementation). In practice this is why
modern OSes (Android/iOS/Windows/macOS) auto-detect captive portals via
a plain-HTTP connectivity-check URL and pop their own "sign in to
network" browser; this ruleset's port-80 DNAT is exactly what that
check depends on.

## Files

- `etc-overlay/etc/config/network` — `wan` (DHCP client) / `lan` (bridge
  `br-lan`, static `10.0.0.1/24`).
- `etc-overlay/etc/config/dhcp` — DHCP server on `lan` only; no DNS
  override (see firewall design above for why).
- `etc-overlay/etc/config/firewall` — minimal zone config (forward drop
  by default) plus a `config include` loading the custom ruleset below.
- `etc-overlay/etc/vendo5-firewall.nft` — the actual table/set/chains,
  loaded via OpenWrt's firewall4 (nftables) `config include` mechanism,
  reloaded whenever the OpenWrt firewall service reloads.

These live under `etc-overlay/` (a new top-level directory, not
`vendo5/etc/`) because they're OpenWrt system config meant to be baked
into the image's rootfs at build time (sub-project #4), not files the
Node app itself reads — distinct from `vendo5/etc/init.d/vendo5` (the
procd service) and `config/*.json` (the app's own config).

## Known shortcuts — verify on real hardware before deployment

- **Interface names (`eth0` for WAN, `eth1` for the USB-to-LAN
  adapter's port) are best-guesses**, not confirmed on real hardware —
  the owner doesn't know the adapter's exact chipset. Fix is one line
  each in `network` and `vendo5-firewall.nft` once confirmed via
  `ip link` on the real device. Not upgrading to dynamic hotplug-based
  interface detection unless real deployment shows interface names are
  unstable across boots/adapter swaps — that would be solving a problem
  this single, fixed deployment doesn't have yet.
- **nftables syntax: validated.** `sudo nft -c -f
  etc-overlay/etc/vendo5-firewall.nft` ran clean (2026-10-10) against a
  real nft binary — this is check mode against the kernel's own
  nftables subsystem, not just a parser. Caught and fixed two real bugs
  in the process: `dnat to ...` is ambiguous in an `inet`-family table
  (needs `dnat ip to ...`), and the placeholder interface name
  `eth0_TODO_VERIFY` exceeded Linux's 15-character interface-name limit
  (`IFNAMSIZ`) — a placeholder that long could never have been valid
  syntax regardless of wording, which is why real short names (`eth0`/
  `eth1`) are used directly now, with the verification caveat kept in
  comments/docs instead of the string itself.
- **UCI syntax validated only by structural review** (balanced
  quotes/braces), not by the real `uci` tool, which isn't installed in
  this sandbox (OpenWrt-specific, not packaged for this dev machine).
- **Still not run on a real device at all** — `nft -c` confirms the
  ruleset is syntactically and semantically loadable by nftables, not
  that `eth0`/`eth1` are the actual interfaces on the real Orange Pi
  One, or that the USB adapter's driver is present in the kernel.
  That's the one remaining on-hardware check.

## Out of scope (still, per sub-project #2's spec)

PPPoE/RADIUS, admin dashboard beyond login+session view, licensing,
vouchers, eLoad, any cloud/remote service call. The SD-card image build
that actually bakes `etc-overlay/` into a flashable rootfs is
sub-project #4, sequenced after this and after the app itself is
considered feature-complete.
