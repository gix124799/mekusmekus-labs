#!/bin/sh

iface="wg0"

host="$(cat /mnt/wifi5/3pinger)"

if [ ! "$host" ]; then
	host="google.com"
fi
while true
do
	c=0;
	ping -I $iface -c 1 -W 1 $host &> /dev/null; ok=$?;
	c=$(($c + $ok))
	ping -I $iface -c 1 -W 1 $host &> /dev/null; ok=$?;
	c=$(($c + $ok))
	ping -I $iface -c 1 -W 1 $host &> /dev/null; ok=$?;
	c=$(($c + $ok))
	ping -I $iface -c 1 -W 1 $host &> /dev/null; ok=$?;
	c=$(($c + $ok))	
		
	if [ $c -lt 4 ]; then
		rule="$(ip rule show fwmark 0x80000 table 100)"
		if [ ! "$rule" ]; then
			ip rule add pref 30000 fwmark 0x80000 table 100
			ip route add table 100 default dev wg0 proto static;
		fi
	else
		rule="$(ip rule show fwmark 0x80000 table 100)"
		if [ "$rule" ]; then
			ip rule del pref 30000 fwmark 0x80000 table 100
			ip route del table 100 default dev wg0 proto static;
		fi
	fi
	sleep 10;
done
