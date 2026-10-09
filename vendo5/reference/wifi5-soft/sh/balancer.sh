#!/bin/sh

for i in /sys/class/net/*/queues/rx-*; do
    echo f > "$i/rps_cpus"
	echo 32768 > "$i/rps_flow_cnt"
done
sysctl -w net.core.netdev_max_backlog=8192
sysctl -w net.core.rps_sock_flow_entries=32768

exit 0