ETHYLNET ORANGE PI ONE — ORIGINAL EXTRACTED FILES
==================================================

Contents are extracted from the user-provided, pristine
    orangepi-one.img.gz
NOT from the previously modified ETHYLNET Unlimited Stable image.

IMPORTANT FILES
---------------
original-firmware/soft/index.o
  49,081,751 bytes | SHA-256: bdb41d0902c889efd352c4a209a2b3979dc6b84df360b93763da3d9236bfc234
  Original ARM 32-bit ELF executable. Its Node.js pkg application is bundled
  in compiled/V8 bytecode form. This is NOT editable/recovered JavaScript source.

original-firmware/soft/public.tar.gz
  37,164,928 bytes | SHA-256: cd6c65d571bc20b9b4cd269ab4030e085f11f44b54f4a31dc751c9f0f436bffd
  Filename from the original ext4 filesystem. This file does NOT begin with
  the standard GZIP magic bytes 1f 8b, and standard `tar -xzf` fails.
  It may be encrypted or use a nonstandard format; this audit does not prove
  which. The ORIGINAL bytes are included unmodified, but the contents have
  NOT been unpacked or decrypted. Do not treat it as ordinary gzip.

original-firmware/soft/build/
  Native addons for epoll/soft on ARM, ARM64 and x86_64.

original-firmware/soft/config/, lib/, sh/, tools/
  Supporting original configs, RADIUS dictionaries, service and helper scripts.

original-firmware/etc/
  Original relevant OpenWrt UCI, startup, network, PPPoE and firewall configs.
  Some files may contain passwords, tokens, or infrastructure details:
  KEEP THIS ZIP PRIVATE and review before sharing publicly.

original-firmware/usr/share/
  Relevant OpenWrt firewall4/nftables/ucode resources.

original-firmware/boot-fat16/
  boot.scr, dtb and uImage individually extracted from original FAT16 partition.
  This is NOT a complete flashable SD-card image. It is an extracted toolkit.

DOCUMENTATION/SHA256SUMS.txt
  Per-file checksums relative to the ZIP's top-level directory.

DOCUMENTATION/FILE_MANIFEST.json
  File sizes and checksums; includes symlink target records.

DOCUMENTATION/PARTITION_AND_FILE_INFO.json
  Image properties, paths and original-source hashes.

EXTRACTION_TOOLS/ext4extract.c
  Minimal read-only libext2fs extractor used for this package. On Ubuntu:
  gcc -O2 ext4extract.c -o ext4extract -lext2fs -lcom_err -luuid -le2p
  ./ext4extract pristine-rootfs.ext4 list /soft
  (Needs libext2fs development headers.)

VERIFICATION
------------
Source compressed IMG SHA-256: da173e2ceb7db1c0b7a5af52959a2e149d8342a5947cc91bdefb139b89185d81
Uncompressed whole SD image SHA-256: d4164f439472dea2485cef6df28745e47a092f38f71624e62c48c1951ff3181d
Original /soft/index.o SHA-256: bdb41d0902c889efd352c4a209a2b3979dc6b84df360b93763da3d9236bfc234
Original /soft/public.tar.gz SHA-256: cd6c65d571bc20b9b4cd269ab4030e085f11f44b54f4a31dc751c9f0f436bffd

This is an ORIGINAL-EXTRACTION package for inspection/development.
It is not a source-code decompiler, and no R6.1 test patches are included.
The source SD image and files were read-only; none were modified in place.
