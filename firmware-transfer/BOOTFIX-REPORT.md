# VENDO5 Orange Pi One boot/feature fixes — R3 candidate

Project: `/home/ethylnet/projects/mekusmekus-labs/vendo5`
Repository: `gix124799/mekusmekus-labs`, source HEAD `f4f66a1729bdc375dc241f0ef258964368e3e6c8` plus accompanying patch.
Date: 12 October 2026 (Asia/Manila).

Changes:
1. Both kernel LED triggers were `none` even while Linux/app ran. Early preinit now sets green power default-on and red heartbeat; UCI defaults retain them during normal startup. Indicators require the kernel to reach preinit.
2. Original firewall init was an empty stub. Restored the standard OpenWrt firewall4 service so the custom nft table loads at boot.
3. Added fw4 LAN-to-WAN forwarding so it does not override paid access; the separate MAC gate still blocks unpaid clients.
4. Restrict established-connection exception to WAN replies, so revoked LAN clients cannot continue existing TCP traffic.
5. Replace static firewall chains atomically on reload, preserving authorization sets and dynamic bandwidth rules while removing duplicates/stale WAN rules.
6. Timestamp the resume-code log hint using the client-log formatter, fixing the customer Logs page crash without appending duplicate stored lines.
7. Build aborts on debugfs errors and verifies filesystem, exact shipped files and protected boot bytes.

Verification:
- 393/393 automated tests and 90/90 browser workflow checks passed.
- Private real-kernel network tests passed: paid downloads, bandwidth limiting, revoked new and existing TCP connections.
- Reload tests passed: no duplicates, preserved live sets/shaping, removed old WAN rules.
- Clean e2fsck; all 1,999 shipped files and overlay files match source.
- Original MBR, SPL/U-Boot, FAT boot partition, kernel, Orange Pi One DTB, boot script and trailer remain identical.
- Original protected init/runtime files, SSH configuration and root password preserved in deliverable.
- Deliberately corrupted SPL rejected by verifier.
- Gzip integrity and raw SHA256 round trip passed.
- Emulator confirmed green default-on/red heartbeat and fw4/vendo5 tables present.
- Final full SD BootROM test results appended after verification.

Emulator is Orange Pi PC/H3, not the exact Orange Pi One. Direct-kernel diagnostics use nosmp/mem=512M only in the emulator. Test copies blank the root password and pad to 2 GiB; the delivered image preserves original size/password/boot arguments.
Physical boot, real USB adapter, coin GPIO, PPPoE clients, audio and soak operation remain hardware tests. This is a hardware-test candidate.

Flash:
1. Download the .img.gz and SHA256SUMS.txt; run `sha256sum --ignore-missing -c SHA256SUMS.txt`.
2. balenaEtcher: Flash from file → select .img.gz → select SD card → flash and finish validation.
3. Safely eject, insert in powered-off Orange Pi One, connect USB LAN adapter/access point, power on.
4. Green on/red heartbeat indicate Linux reached preinit. LAN is 10.0.0.1; direct app/admin uses http://10.0.0.1:3000/admin.
5. Change the factory application admin password.
6. If still no indicators, compare a known-working card/image and capture a 3.3 V UART log at 115200 baud.

Sources/rebuild:
Apply vendo5-bootfix-r3.patch from the mekusmekus-labs repository root. Fixes remain in that working tree; unrelated work preserved.
Build: `OUT=build/vendo5-orangepi-one-bootfix-r3.img bash scripts/build-image.sh`
Verify: `python3 scripts/verify-image.py build/base.img build/vendo5-orangepi-one-bootfix-r3.img`
Compress: `gzip -n -6 -c build/vendo5-orangepi-one-bootfix-r3.img > build/vendo5-orangepi-one-bootfix-r3.img.gz`

References:
https://github.com/openwrt/firewall4/blob/master/root/etc/init.d/firewall
https://www.qemu.org/docs/master/system/arm/orangepi.html
https://netfilter.org/projects/nftables/manpage.html

SHA256:
Raw: 579816c52d5a46834f5340c367f3066ee85967035255c36eda1eb598022353b3
Gzip: d0bb780e75657b2d05825a6342adc835808f9c7096302cf8a182eb8f12c9f249
