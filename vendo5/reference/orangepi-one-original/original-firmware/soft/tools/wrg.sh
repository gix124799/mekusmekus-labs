#!/bin/sh

device=$3
iface=$1
action=$2


svr(){
if [ -e '/etc/init.d/wrgfail' ]; then
	if [ "$(/etc/init.d/wrgfail status 2>&1)" == "inactive" ]; then
		/etc/init.d/wrgfail start;
	fi
else
/bin/cat <<EOM >/etc/init.d/wrgfail
#!/bin/sh /etc/rc.common

USE_PROCD=1

start_service() {
	logger -t "Wireguard" "Start";
	procd_set_param respawn
	procd_open_instance
    procd_set_param command /soft/tools/wrgfailover.sh;
    procd_set_param stdout 0
    procd_set_param stderr 0
    procd_close_instance
}
stop_service() {
	logger -t "Wireguard" "Stop";
}
EOM
chmod 755 /etc/init.d/wrgfail
/etc/init.d/wrgfail start;
fi
}

route(){
	local proto address mask nexthop source
	. /usr/share/libubox/jshn.sh;
	json_init;
	json_load "$(ifstatus $iface)";
	json_get_vars proto
	if [ $proto == "wireguard" ]; then
		svr
	fi
}

if [ $action == "ifup" ] && [ $iface == "wg0" ]; then
	if [ "$device" ]; then
		route
	fi
fi

if [ $action == "ifdown" ] && [ $iface == "wg0" ]; then
	/etc/init.d/wrgfail stop
	ip rule del fwmark 0x80000 table 100
fi