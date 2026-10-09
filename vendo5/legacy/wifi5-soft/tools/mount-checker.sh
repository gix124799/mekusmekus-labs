#!/bin/sh

while read -r line; do
    READONLY=$(echo "$line" | grep -E '(ro,)')
	[ "$READONLY" ] && {
		DEV=$(echo $READONLY | awk '{print $1}')
		MOUNT=$(echo $READONLY | awk '{print $2}')
		e2fsck -y $DEV
		mount -o remount $DEV $MOUNT
	}
done < /proc/mounts