#!/bin/bash
# Build a test SD image for Orange Pi One: pristine OpenWrt base + vendo5 app + our UCI/nft config.
# No root needed: patches the ext4 rootfs in place with debugfs. Usage: scripts/build-image.sh [base.img.gz]
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_GZ=${1:-$HOME/Downloads/orangepi-one.img.gz}
BASE_SHA=d4164f439472dea2485cef6df28745e47a092f38f71624e62c48c1951ff3181d  # uncompressed pristine image
OUT=${OUT:-build/vendo5-orangepi-one-test.img}
ROOT_OFFSET=69206016  # partition 2 start (see reference/.../PARTITION_AND_FILE_INFO.json)

mkdir -p build
gunzip -ck "$BASE_GZ" > "$OUT"
echo "$BASE_SHA  $OUT" | sha256sum -c - >/dev/null || { echo "base image is not the pristine one" >&2; exit 1; }
PRISTINE=$(mktemp build/pristine-verify.XXXXXX.img)
trap 'rm -f "$PRISTINE"' EXIT
cp --reflink=auto --sparse=always "$OUT" "$PRISTINE"
D="$OUT?offset=$ROOT_OFFSET"

# root ssh/console password (md5-crypt; same hash form the base image already uses for shadow). The
# previous build's default ("kulangot") was typed into a chat/release-notes draft and is retired; this
# one is a fresh random value never written in plaintext anywhere in the repo or its history. Get it
# out-of-band from whoever ran this build, then `passwd` on first login.
ROOT_HASH='$1$aea0e17d$hzl8eRnGB0ol/NUm5RmNa.'
SHADOW=build/shadow.new
debugfs -R "cat /etc/shadow" "$D" 2>/dev/null | sed "s#^root:[^:]*:#root:$ROOT_HASH:#" > "$SHADOW"

CMD=build/debugfs.cmd
{
  # retire the licensed original app and phone-home services; keep nginx as the port-80 portal proxy
  for l in S200soft S250ngrok S90zerotier; do echo "rm /etc/rc.d/$l"; done
  echo "rm /soft/index.o"
  # app tree
  echo "mkdir /mnt/wifi5"
  node scripts/image-commands.js   # app, config, theme, admin frontend (main+nav) and socket.io, with their directories
  # OpenWrt system config + service
  for f in network dhcp firewall; do echo "rm /etc/config/$f"; echo "write etc-overlay/etc/config/$f /etc/config/$f"; done
  echo "rm /soft/config/nginx.locations"
  echo "write etc-overlay/etc/vendo5-nginx.locations /soft/config/nginx.locations"
  echo "write etc-overlay/etc/vendo5-firewall.nft /etc/vendo5-firewall.nft"
  echo "write etc-overlay/etc/vendo5-netdetect.sh /etc/vendo5-netdetect.sh"
  echo "set_inode_field /etc/vendo5-netdetect.sh mode 0100755"
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
debugfs -w -f "$CMD" "$D" > build/debugfs.log 2>&1
# debugfs can return zero even when individual commands failed.
if grep -Ei 'file not found|file exists|no space|command not found|usage:|while (opening|writing|reading)' build/debugfs.log; then
  echo "debugfs command failed; image is not releasable" >&2
  exit 1
fi
python3 scripts/verify-image.py "$PRISTINE" "$OUT"
sha256sum "$OUT" | tee "$OUT.sha256"
