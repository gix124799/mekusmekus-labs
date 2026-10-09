
if [ "$(md5sum /etc/config/nginx | awk '{print $1;}')" != "dde33a765d515e67fb9f02650f3d0a9e" ]; then
	cp /soft/config/nginx /etc/config/nginx;
	/etc/init.d/nginx restart;
fi

if [ "$(uci -q show network.pppoe)" == "" ]; then
	uci set network.pppoe='interface';
	uci set network.pppoe.proto='static';
	uci set network.pppoe.ifname='@lan';
	uci set network.pppoe.ipaddr='11.0.0.1';
	uci set network.pppoe.netmask='255.255.255.0';
	uci commit network;
	/etc/init.d/network restart;
fi