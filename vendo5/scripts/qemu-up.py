#!/usr/bin/env python3
"""Boot build/vendo5-orangepi-one-test.img under QEMU and leave it running (a copy; the image file is untouched).
The guest's portal/admin (port 3000) is forwarded to http://127.0.0.1:3300, its serial console is the unix socket
build/serial.sock (use scripts/qemu-sh.py to run commands). Root's password is blanked in the COPY only.
   python3 scripts/qemu-up.py          boot (waits until the app answers, several minutes)
   python3 scripts/qemu-up.py stop     power it off"""
import os, re, shutil, socket, subprocess, sys, time
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build'))
if len(sys.argv) > 1 and sys.argv[1] == 'stop':
    subprocess.run(['pkill', '-f', 'qemu-system-arm.*qemu-run.img']); sys.exit(0)
B = '../reference/orangepi-one-original/original-firmware/boot-fat16'
shutil.copy('vendo5-orangepi-one-test.img', 'qemu-run.img')
D = 'qemu-run.img?offset=69206016'
shadow = subprocess.run(['debugfs', '-R', 'cat /etc/shadow', D], capture_output=True, text=True).stdout
open('shadow.tmp', 'w').write(re.sub(r'^root:[^:]*:', 'root::', shadow, flags=re.M))
subprocess.run(['debugfs', '-w', '-R', 'rm /etc/shadow', D], capture_output=True)
subprocess.run(['debugfs', '-w', '-R', 'write shadow.tmp /etc/shadow', D], capture_output=True)
subprocess.run(['qemu-img', 'resize', '-f', 'raw', 'qemu-run.img', '2G'], check=True, capture_output=True)
if os.path.exists('serial.sock'): os.remove('serial.sock')
subprocess.Popen(['qemu-system-arm', '-M', 'orangepi-pc', '-m', '1024', '-display', 'none', '-monitor', 'none',
    '-serial', 'unix:serial.sock,server=on,wait=off', '-kernel', B + '/uImage', '-dtb', B + '/dtb',
    '-append', 'console=ttyS0,115200 root=/dev/mmcblk0p2 rootwait', '-drive', 'file=qemu-run.img,if=sd,format=raw',
    '-nic', 'user,hostfwd=tcp:127.0.0.1:3300-:3000'], stderr=open('qemu.err', 'w'), stdout=subprocess.DEVNULL, start_new_session=True)
print('qemu started; waiting for the portal on http://127.0.0.1:3300 ...', flush=True)
import urllib.request
t = time.time()
while time.time() - t < 900:
    try:
        urllib.request.urlopen('http://127.0.0.1:3300/api/status', timeout=3).read(); print('UP after %ds' % (time.time() - t)); break
    except Exception: time.sleep(5)
else: print('FAIL: not up'); sys.exit(1)
