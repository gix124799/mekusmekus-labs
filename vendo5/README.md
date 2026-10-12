# vendo5

Piso-WiFi vendo controller for the Orange Pi One — coin/voucher-based internet access portal, admin
dashboard, and OpenWrt network/firewall glue. Replaces the original licensed `wifi5-soft` app.

## Hardware

Two supported targets:

- **Orange Pi One** (Allwinner H3/ARM) — on-board Ethernet = WAN, USB-to-Ethernet adapter = LAN, bridged
  as `br-lan` (`10.0.0.1/19`). A separate standalone access point (AP/bridge mode, no DHCP of its own)
  plugged into the LAN port. Coin acceptor on GPIO 12, its power relay on GPIO 11 (see `config/vendo.json`).
  This is the per-location box with a customer-facing portal.
- **x86_64 mini PC** (the vendor's own box, built-in VLAN switch chip) — central controller role: no coin
  acceptor, manages multiple Orange Pi sub-vendos over the signed poll protocol (`lib/subvendo.js`). Its
  `/etc/config/network` is left exactly as shipped (the switch's VLAN ports already feed `br-lan`
  correctly); only the firewall/dhcp/app layer is swapped in.

Full pre-flight list: `docs/hardware-checklist.md`.

## Build an image

```
scripts/build-image.sh [path/to/orangepi-one.img.gz]        # Orange Pi One (ARM)
scripts/build-image-x86.sh [path/to/x86_64-efi.img.gz]       # x86_64 mini PC
```

Patches a pristine OpenWrt base image with the app, UI, config, and firewall rules (no root needed —
uses `debugfs`), then runs `scripts/verify-image.py --target arm|x86` as a release gate. Output:
`build/<name>.img` plus a `.sha256` next to it.

## Flash and first boot

1. Flash the built `.img` to an SD card (`dd` or Raspberry Pi Imager's "custom image" option).
2. Boot the Pi with the LAN-side USB adapter already plugged in.
3. Connect a phone to the AP's Wi-Fi. The portal loads at `http://10.0.0.1/`, admin at
   `http://10.0.0.1/admin` (factory `admin`/`admin` — change it on first login).
4. SSH: `ssh root@10.0.0.1` (see the image's release notes for the current default password).

## Develop

```
npm install
npm test          # node --test test/*.test.js
npm run dev        # watches lib/, main.js, config/
```

Runs against fake GPIO/uci/firewall on a development machine; `docs/hardware-checklist.md` tracks what
only real hardware can confirm.

## Docs

- `docs/hardware-checklist.md` — real-hardware verification checklist.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design specs and implementation plans.
- `docs/terms-of-service.md` — end-user terms shown to customers of the piso-wifi service.
- `CHANGELOG.md` — release history.

## License

Proprietary — see `LICENSE`. All rights reserved.
