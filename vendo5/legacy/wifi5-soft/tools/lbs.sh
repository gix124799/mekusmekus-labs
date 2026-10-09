#!/bin/sh

device=$3
iface=$1
action=$2


route(){
	local proto address mask nexthop source
	. /usr/share/libubox/jshn.sh;
	json_init;
	json_load "$(ifstatus $iface)";
	json_get_vars proto
	if [ $proto == "dhcp" ]; then
		if json_is_a ipv4_address array
		then
			json_select 'ipv4_address'
			json_select 1
			json_get_vars address mask
			json_select ..
			json_select ..
		fi
		if json_is_a route array
		then
			json_select 'route'
			json_select 1
			json_get_vars nexthop source
		fi
		if [ "$nexthop" ] && [ "$address" ]; then
			metric=0;
			if [ "$iface" == "wan" ]; then
				metric=10
			fi
			if [ "$iface" == "wan2" ]; then
				metric=11
			fi
			route="$(ip route show default dev $device)"
			if [ "$route" ]; then
				ip route del $route
			fi
			route="$(ip route show default dev $device metric $metric)"
			if [ "$route" ]; then
				ip route del $route
			fi
			ip route append default via $nexthop dev $device proto static src $address metric $metric
		fi
	fi
}

svr(){
if [ -e '/etc/init.d/lbsfail' ]; then
	if [ "$(/etc/init.d/lbsfail status 2>&1)" == "inactive" ]; then
		/etc/init.d/lbsfail start;
	fi
else
/bin/cat <<EOM >/etc/init.d/lbsfail
#!/bin/sh /etc/rc.common

USE_PROCD=1

start_service() {
	logger -t "ISP Mode" "Dual Load Balance Start";
	procd_set_param respawn
	procd_open_instance
    procd_set_param command node /soft/tools/lbs.js;
    procd_set_param stdout 0
    procd_set_param stderr 0
    procd_close_instance
}
stop_service() {
	logger -t "ISP Mode" "Dual Load Balance Stop";
}
EOM
chmod 755 /etc/init.d/lbsfail
/etc/init.d/lbsfail start;
fi
}

if [ $action == "ifup" ]; then
	if [ "$device" ]; then
		/etc/init.d/dsafail stop &> /dev/null;
		ip route flush table 300 &> /dev/null;
		ip route flush table 400 &> /dev/null;
		ip rule del table 300 &> /dev/null;
		ip rule del table 300 &> /dev/null;
		ip rule del table 400 &> /dev/null;
		ip rule del table 400 &> /dev/null;
		while [ ! "$(ip rule del table 300 2>&1)" ]
		do
			:;
		done
		while [ ! "$(ip rule del table 400 2>&1)" ]
		do
			:;
		done
		route
		svr
	fi
fi

if [ $action == "ifdown" ]; then
	/etc/init.d/lbsfail stop;
fi
