#!/bin/sh

DISK=$(lsblk -lp |grep -E "/$"|awk '{print $1}');
if [ ! $DISK ]; then
	DISK=$(lsblk -lp |grep -E "/rom$"|awk '{print $1}');
fi
if [ $DISK ]; then
  e2fsck -y $DISK
fi
