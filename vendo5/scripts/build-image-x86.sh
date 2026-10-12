#!/bin/bash
# Build a test image for the vendor's own x86_64 mini PC (UEFI/grub, built-in VLAN switch): pristine
# OpenWrt base + vendo5 app + our firewall/dhcp config. No root needed: patches the ext4 rootfs in
# place with debugfs. Usage: scripts/build-image-x86.sh [x86_64-efi.img.gz]
#
# Unlike build-image.sh (bare Orange Pi One + USB LAN adapter), this box is the vendor's own hardware:
# /etc/config/network already wires its real switch-chip LAN ports (VLAN) into br-lan correctly, so it
# is left exactly as shipped. There is also no WAN/LAN interface-name ambiguity to detect at boot (eth0
# is always both the WAN uplink and the VLAN trunk to the switch), so vendo5-netdetect.sh is not used.
# This box has no coin acceptor GPIO wired to it either — it's a central controller for sub-vendos, and
# main.js already runs fine without one (logs "coin gpio unavailable; portal runs without coin input").
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_GZ=${1:-$HOME/Downloads/x86_64-efi.img.gz}
BASE_SHA=66fcf28f807eb720787d8e740a1fc56b705d50f246e4ba0f3312a8b138386202  # uncompressed pristine image
OUT=${OUT:-build/vendo5-x86-test.img}
ROOT_OFFSET=67371008  # root partition start (GPT, this base image's fixed layout)

mkdir -p build
# this base .gz has trailing garbage after the real stream (exit 2, decompression itself is fine);
# the sha256 check right after is what actually guards against a corrupt/wrong base image.
gunzip -ck "$BASE_GZ" > "$OUT" || [ $? -eq 2 ]
echo "$BASE_SHA  $OUT" | sha256sum -c - >/dev/null || { echo "base image is not the pristine one" >&2; exit 1; }
PRISTINE=$(mktemp build/pristine-verify.XXXXXX.img)
trap 'rm -f "$PRISTINE"' EXIT
cp --reflink=auto --sparse=always "$OUT" "$PRISTINE"
D="$OUT?offset=$ROOT_OFFSET"

# root ssh/console password (md5-crypt) — same value as build-image.sh's; keep the two in sync.
ROOT_HASH='$1$aea0e17d$hzl8eRnGB0ol/NUm5RmNa.'
SHADOW=build/shadow-x86.new
debugfs -R "cat /etc/shadow" "$D" 2>/dev/null | sed "s#^root:[^:]*:#root:$ROOT_HASH:#" > "$SHADOW"

CMD=build/debugfs-x86.cmd
{
  # retire the licensed original app and phone-home services; keep nginx as the port-80 portal proxy
  for l in S200soft S250ngrok S90zerotier; do echo "rm /etc/rc.d/$l"; done
  echo "rm /soft/index.o"
  # app tree
  echo "mkdir /mnt/wifi5"
  node scripts/image-commands.js   # app, config, theme, admin frontend (main+nav) and socket.io, with their directories
  # OpenWrt system config + service — network is NOT touched (see header comment)
  for f in dhcp firewall; do echo "rm /etc/config/$f"; echo "write etc-overlay/etc/config/$f /etc/config/$f"; done
  echo "rm /soft/config/nginx.locations"
  echo "write etc-overlay/etc/vendo5-nginx.locations /soft/config/nginx.locations"
  echo "write etc-overlay/etc/vendo5-firewall.nft /etc/vendo5-firewall.nft"
  echo "rm /etc/init.d/firewall"
  echo "write etc-overlay/etc/init.d/firewall /etc/init.d/firewall"
  echo "set_inode_field /etc/init.d/firewall mode 0100755"
  echo "write etc/init.d/vendo5 /etc/init.d/vendo5"
  echo "set_inode_field /etc/init.d/vendo5 mode 0100755"
  echo "symlink /etc/rc.d/S95vendo5 ../init.d/vendo5"
  echo "rm /etc/shadow"
  echo "write $SHADOW /etc/shadow"
  echo "set_inode_field /etc/shadow mode 0100600"
} > "$CMD"
debugfs -w -f "$CMD" "$D" > build/debugfs-x86.log 2>&1
# debugfs can return zero even when individual commands failed.
if grep -Ei 'file not found|file exists|no space|command not found|usage:|while (opening|writing|reading)' build/debugfs-x86.log; then
  echo "debugfs command failed; image is not releasable" >&2
  exit 1
fi
python3 scripts/verify-image.py --target x86 "$PRISTINE" "$OUT"
sha256sum "$OUT" | tee "$OUT.sha256"
