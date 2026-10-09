#!/bin/sh

. /usr/share/libubox/jshn.sh
json_init;
json_load "$(ubus call system board)"
json_get_var board_name board_name

while [[ $# -gt 0 ]]; do
  case $1 in
	--loader)
	  LOADER="$2"
      shift
      shift
	;;
	--firmware)
	  FIRMWARE="$2"
      shift
      shift
	;;
    *)
      shift
      ;;
  esac
done

case "$(echo "$board_name" | grep -o -i -E 'orangepi-5|orangepi-5-plus')" in
	orangepi-5)
		if [ "$LOADER" ]; then
			wget $LOADER -O /tmp/openwrt_rkspi_loader.bin
		else
			wget https://files.wifi5-soft.com/files/others/rkspi_loader-opi-5.img -O /tmp/openwrt_rkspi_loader.bin
		fi
		if [ "$FIRMWARE" ]; then
			wget $FIRMWARE -O /tmp/firmware.bin
		else
			wget https://files.wifi5-soft.com/files/others/firmware-opi-5.bin -O /tmp/firmware.bin
		fi
	;;
	orangepi-5-plus)
		if [ "$LOADER" ]; then
			wget $LOADER -O /tmp/openwrt_rkspi_loader.bin
		else
			wget https://files.wifi5-soft.com/files/others/rkspi_loader-opi-5-plus.img -O /tmp/openwrt_rkspi_loader.bin
		fi
		if [ "$FIRMWARE" ]; then
			wget $FIRMWARE -O /tmp/firmware.bin
		else
			wget https://files.wifi5-soft.com/files/others/firmware-opi-5-plus.bin -O /tmp/firmware.bin
		fi
	;;
	*)
		echo "$board_name not supported"
	;;
esac

if [ -f /tmp/firmware.bin ]; then
	dd if=/tmp/firmware.bin of=/dev/mtdblock1 conv=noerror,sync
fi
if [ -f /tmp/openwrt_rkspi_loader.bin ]; then
	echo "Flashing spi please wait."
	dd if=/tmp/openwrt_rkspi_loader.bin of=/dev/mtdblock0 conv=noerror,sync
	echo "Please reboot to boot nvme, sd."
fi
echo "done."