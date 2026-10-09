#!/bin/sh

case "$1" in
	add)
		if [ $DNSMASQ_INTERFACE ]; then
			ip neigh replace $3 lladdr $2 dev $DNSMASQ_INTERFACE nud permanent
		fi
	;;
	del)
		if [ $DNSMASQ_INTERFACE ]; then
			ip neigh delete $3 lladdr $2 dev $DNSMASQ_INTERFACE
		fi
	;;
	old)
		if [ $DNSMASQ_INTERFACE ]; then
			ip neigh replace $3 lladdr $2 dev $DNSMASQ_INTERFACE nud permanent
		fi
	;;
esac
if [ $DNSMASQ_INTERFACE ] && [ $3 ] && [ $2 ]; then
    echo "$1 $3 $2 $DNSMASQ_INTERFACE $DNSMASQ_LEASE_EXPIRES $4" | nc 127.0.0.1 1337 > /dev/null 2>&1
fi
