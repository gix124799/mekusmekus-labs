if [ "$(uci -q get dhcp.@dnsmasq[0].leasefile)" == '/usr/dhcp.leases' ] || [ "$(uci -q get dhcp.@dnsmasq[0].leasefile)" == '/tmp/dhcp.leases' ] || ( ! uci -q get dhcp.@dnsmasq[0].leasefile > /dev/null ) ; then
	uci -q set dhcp.@dnsmasq[0].leasefile='/mnt/wifi5/dhcp.leases'
	dhcp=1
fi

if ( uci -q get dhcp.@dnsmasq[0].notinterface > /dev/null ); then
	uci -q del dhcp.@dnsmasq[0].notinterface
	dhcp=1
fi

if ( uci -q get dhcp.@dnsmasq[0].dhcpleasemax > /dev/null ); then
	uci -q del dhcp.@dnsmasq[0].dhcpleasemax
	echo "dhcp-lease-max=32760" > /etc/dnsmasq.conf
	dhcp=1
fi

if ( ! uci -q get dhcp.@dnsmasq[0].dhcpscript > /dev/null ); then
	uci set dhcp.@dnsmasq[0].dhcpscript='/soft/sh/dhcp.script.sh'
	dhcp=1
fi

if [ "$(uci -q get dhcp.lan.leasetime)" == "24h" ]; then
	uci set dhcp.lan.leasetime='72h'
    dhcp=1
fi

if ( ! uci -q get network.lan.type ); then
	uci set network.lan.type='dhcp'
	uci commit network
fi

if [ "$(uci -q get dhcp.lan.dhcpv6)" == "server" ]; then
	uci set dhcp.lan.dhcpv6='disabled'
    uci -q delete dhcp.lan.ra
	uci commit
	/etc/init.d/odhcpd disable
	/etc/init.d/odhcpd stop
	/etc/init.d/network restart
	dhcp=1
fi

if [ $dhcp ]; then
	uci commit dhcp;
	/etc/init.d/dnsmasq restart;
fi
