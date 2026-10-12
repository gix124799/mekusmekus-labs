# Changelog

## v1.0.0 — 2026-10-13 (first stable release)

### Added since initial tag
- Second build target: `scripts/build-image-x86.sh` for the vendor's x86_64 mini PC, meant as a central
  controller for Orange Pi sub-vendos (no coin GPIO). Its VLAN network config is left as shipped — real
  switch hardware, unlike the bare Orange Pi One's USB-adapter workaround. `scripts/verify-image.py`
  gained a `--target arm|x86` flag to gate each image's release the right way.

First image built and verified end-to-end on real Orange Pi One hardware.

### Highlights
- Coin/voucher-based captive portal, admin dashboard, and reseller portal, replacing the original
  licensed `wifi5-soft` app.
- GPIO coin acceptor with pulse-train/noise guard, relay control, and pin configuration.
- Session/wallet engine: pause/resume, trial sessions, resume codes that follow a device's new MAC,
  data caps, rate tables.
- Sub-vendo support: multiple coin slots/vendos reporting to one controller over a signed, nonce-chained
  poll protocol, with per-vendo guards and one payer per vendo.
- Network/firewall: OpenWrt UCI config for WAN/LAN, nftables captive-portal redirect (plain HTTP only —
  HTTPS is dropped, not DNAT'd to a self-signed cert), per-device speed shaping, walled garden.
- Admin pages for network (interfaces, DHCP/leases, wireless, port forwarding, NTP, scheduler), PPPoE,
  media, chat, and system backup/restore/update.
- Build pipeline: `scripts/build-image.sh` patches a pristine base image with no root required, gated by
  `scripts/verify-image.py` (boot bytes, shipped files, and a known root password all verified before
  an image is considered releasable).

### Fixed before this release
- Captive portal not loading on real hardware: unpaid clients' HTTPS traffic was being DNAT'd to nginx's
  self-signed certificate, which fails the browser's TLS handshake before the plain-HTTP redirect is
  ever seen. HTTPS is now dropped for unpaid clients instead, as the firewall file's own design comment
  already described.

### Known gaps
See "Known gaps to expect" in `docs/hardware-checklist.md` — speed limits are packet policing (not queue
shaping), e-load/online payment/phone-rental/vendor cloud are intentionally offline, and a few portal
fields were inferred from obfuscated scripts pending real-use confirmation.
