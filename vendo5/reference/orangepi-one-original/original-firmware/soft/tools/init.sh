#!/bin/sh

. /soft/sh/nginx.sh
. /soft/sh/interface.sh
. /soft/sh/dnsmasq.sh
. /soft/sh/disable-ipv6.sh

if  ! [ -f /usr/bin/check-disk ]; then
  chmod 0775 /soft/sh/check-disk.sh;
  ln -s /soft/sh/check-disk.sh /usr/bin/check-disk;
fi

if  ! [ -f /usr/bin/flash-spi-opi5 ]; then
  chmod 0775 /soft/sh/flash-spi.sh;
  ln -s /soft/sh/flash-spi.sh /usr/bin/flash-spi-opi5;
fi


if [ "$(uci -q get system.ntp.server|grep -E openwrt.pool)" ]; then
	uci delete system.ntp.server;
	uci add_list system.ntp.server='132.163.97.3';
	uci add_list system.ntp.server='202.90.132.242';
	uci commit system
	/etc/init.d/sysntpd restart;
fi

if [ "$(uci -q get dropbear.main.Interface)" ]; then
	uci delete dropbear.main.Interface;
	uci commit dropbear;
	/etc/init.d/dropbear restart;
fi

if [ "$(uci -q get zerotier.global)" ]; then
	cp /soft/config/zerotier /etc/config/zerotier
fi