#!/bin/sh

device=$3
iface=$1
action=$2

/etc/init.d/dsafail stop &> /dev/null;
/etc/init.d/lbsfail stop &> /dev/null;

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
