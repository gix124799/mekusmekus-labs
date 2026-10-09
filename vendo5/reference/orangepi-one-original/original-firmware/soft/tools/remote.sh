#!/bin/sh

if [ "$(uci -q get network.wgremote)" ]; then
	uci -q delete network.wgremote;
fi
