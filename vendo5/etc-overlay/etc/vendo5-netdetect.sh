#!/bin/sh
# Boot-time WAN/LAN port detection, so a wrong guess at "eth0/eth1" can never leave the box stuck on
# "obtaining IP address" / "no internet". Owner topology: the on-board Ethernet is the WAN, the USB-to-LAN
# adapter's port is the LAN (bridged into br-lan). A USB NIC's /sys/class/net/<n>/device resolves through
# /usb*, the on-board one does not. When both are found and the config disagrees, fix UCI + the firewall's
# `define WAN` line and reload; otherwise leave everything alone and say why in the log.
# Test hooks: SYSNET, UCI, NFT_FILE, RELOAD, WAIT (all default to the real thing).
SYSNET=${SYSNET:-/sys/class/net}
UCI=${UCI:-uci}
NFT_FILE=${NFT_FILE:-/etc/vendo5-firewall.nft}
RELOAD=${RELOAD:-reload_all}
say() { logger -t vendo5 "$*" 2>/dev/null; echo "vendo5: $*" >&2; }
reload_all() { /etc/init.d/network reload; /etc/init.d/firewall reload; }

scan() {
	onboard=; usb=
	for d in "$SYSNET"/*; do
		n=${d##*/}
		[ -e "$d/device" ] && [ ! -e "$d/wireless" ] && [ ! -e "$d/phy80211" ] && [ ! -e "$d/bridge" ] || continue
		[ "$(cat "$d/type" 2>/dev/null)" = 1 ] || continue
		case $n in *[!A-Za-z0-9_.-]*|'') continue ;; esac
		if readlink -f "$d/device" | grep -q '/usb'; then usb="$usb $n"; else onboard="$onboard $n"; fi
	done
}
# a USB NIC enumerates a few seconds after the kernel boots, possibly after this runs: wait for it (WAIT seconds)
tries=0; scan
while [ -z "$usb" ] && [ "$tries" -lt "${WAIT:-20}" ]; do sleep 1; tries=$((tries + 1)); scan; done
set -- $onboard; wan=$1; [ $# -le 1 ] || say "netdetect: several on-board NICs ($onboard), using $wan as WAN"
set -- $usb; lan=$1; [ $# -le 1 ] || say "netdetect: several USB NICs ($usb), using $lan as LAN"

if [ -z "$wan" ] || [ -z "$lan" ]; then
	say "netdetect: could not tell WAN from LAN (on-board:[$onboard ] usb:[$usb ]); config left as is. Plug in the USB LAN adapter and reboot."
	exit 0
fi

cur_wan=$($UCI -q get network.wan.device)
cur_lan=$($UCI -q get network.br_lan.ports)
changed=
if [ "$cur_wan" != "$wan" ]; then $UCI set "network.wan.device=$wan" && changed=1; fi
if [ "$cur_lan" != "$lan" ]; then
	$UCI -q delete network.br_lan.ports; $UCI add_list "network.br_lan.ports=$lan" && changed=1
fi
if [ -f "$NFT_FILE" ] && ! grep -q "^define WAN = \"$wan\"\$" "$NFT_FILE"; then
	sed -i "s/^define WAN = .*/define WAN = \"$wan\"/" "$NFT_FILE" && changed=1
fi
if [ -n "$changed" ]; then
	$UCI commit network
	say "netdetect: WAN=$wan LAN=$lan (was WAN=$cur_wan LAN=$cur_lan); network and firewall reloaded"
	eval "$RELOAD"
else
	say "netdetect: WAN=$wan LAN=$lan as configured"
fi
