. /lib/functions.sh
. /lib/functions/system.sh

index=0;
vlan_interface() {
	config_get type $1 type
	config_get vid $1 vid
	config_get macaddr $1 macaddr
	config_get ifname $1 ifname
	config_get mac $1 mac
	if [ "$type" == "8021q" ] && [ ! $macaddr ] && [ "$mac" != "0" ]; then
		newmac=$(macaddr_random)
		uci set network.@device[$index].macaddr=$newmac
		MAC_FOUND=1
	fi
	index=$(($index+1))
}

config_load network
config_foreach vlan_interface device

if [ $MAC_FOUND ]; then
  uci commit network
  /etc/init.d/network restart
fi
