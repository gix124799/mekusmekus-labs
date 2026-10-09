#!/bin/bash
# Build a test SD image for Orange Pi One: pristine OpenWrt base + vendo5 app + our UCI/nft config.
# No root needed: patches the ext4 rootfs in place with debugfs. Usage: scripts/build-image.sh [base.img.gz]
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_GZ=${1:-$HOME/Downloads/orangepi-one.img.gz}
BASE_SHA=d4164f439472dea2485cef6df28745e47a092f38f71624e62c48c1951ff3181d  # uncompressed pristine image
OUT=build/vendo5-orangepi-one-test.img
ROOT_OFFSET=69206016  # partition 2 start (see reference/.../PARTITION_AND_FILE_INFO.json)

mkdir -p build
gunzip -ck "$BASE_GZ" > "$OUT"
echo "$BASE_SHA  $OUT" | sha256sum -c - >/dev/null || { echo "base image is not the pristine one" >&2; exit 1; }
D="$OUT?offset=$ROOT_OFFSET"

CMD=build/debugfs.cmd
{
  # retire the licensed original app and the services that would fight for port 80 / phone home
  for l in S200soft S80nginx S250ngrok S90zerotier; do echo "rm /etc/rc.d/$l"; done
  echo "rm /soft/index.o"
  # app tree
  echo "mkdir /opt"; echo "mkdir /opt/vendo5"; echo "mkdir /mnt/wifi5"
  for d in lib config public public/theme; do echo "mkdir /opt/vendo5/$d"; done
  for f in main.js package.json lib/*.js config/*.json public/theme/*; do echo "write $f /opt/vendo5/$f"; done
  # OpenWrt system config + service
  for f in network dhcp firewall; do echo "rm /etc/config/$f"; echo "write etc-overlay/etc/config/$f /etc/config/$f"; done
  echo "write etc-overlay/etc/vendo5-firewall.nft /etc/vendo5-firewall.nft"
  echo "write etc/init.d/vendo5 /etc/init.d/vendo5"
  echo "set_inode_field /etc/init.d/vendo5 mode 0100755"
  echo "symlink /etc/rc.d/S95vendo5 ../init.d/vendo5"
} > "$CMD"
debugfs -w -f "$CMD" "$D" > build/debugfs.log 2>&1
e2fsck -fn "$D" | tail -2
sha256sum "$OUT" | tee "$OUT.sha256"
