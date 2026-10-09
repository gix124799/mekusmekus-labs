#!/bin/sh
sysctl -w net.ipv6.conf.all.forwarding=1 > /dev/null #Enable
sysctl -w net.ipv6.conf.all.disable_ipv6=0 > /dev/null #Enable
sysctl -w net.ipv6.conf.default.forwarding=1 > /dev/null #Enable