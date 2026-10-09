#!/usr/bin/env python3
"""Boot build/vendo5-orangepi-one-test.img under QEMU (Allwinner H3 == Orange Pi One SoC), check vendo5 serves the portal."""
import os, re, shutil, socket, subprocess, sys, time
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build'))
B = '../reference/orangepi-one-original/original-firmware/boot-fat16'
shutil.copy('vendo5-orangepi-one-test.img', 'qemu-run.img')
subprocess.run(['qemu-img', 'resize', '-f', 'raw', 'qemu-run.img', '2G'], check=True, capture_output=True)  # SD size must be 2^n
q = subprocess.Popen(['qemu-system-arm', '-M', 'orangepi-pc', '-m', '1024', '-display', 'none',
    '-serial', 'tcp:127.0.0.1:5555,server=on,wait=off', '-kernel', B + '/uImage', '-dtb', B + '/dtb',
    '-append', 'console=ttyS0,115200 root=/dev/mmcblk0p2 rootwait', '-drive', 'file=qemu-run.img,if=sd,format=raw', '-nic', 'user'],
    stderr=open('qemu.err', 'w'))
try:
    time.sleep(2); s = socket.create_connection(('127.0.0.1', 5555)); s.settimeout(1); buf = ''
    log = open('serial.log', 'w')
    def pump(secs):
        global buf
        end = time.time() + secs
        while time.time() < end:
            try: d = s.recv(4096).decode(errors='replace')
            except socket.timeout: continue
            buf += d; log.write(d); log.flush()
    t = time.time()
    while 'press Enter' not in buf and time.time() - t < 400: pump(2)
    assert 'press Enter' in buf, 'FAIL: no console'
    pump(60)  # let rc.d finish
    s.send(b'\r\n'); pump(3)
    s.send(b'echo N=$(ps | grep -c "[n]ode /opt/vendo5")X; echo A=$(wget -qO- http://127.0.0.1:3000/api/status)X; echo P=$(wget -qO- http://127.0.0.1:3000/ | grep -c client-insert-coin)X; echo L=$(wget -qO- http://127.0.0.1:3000/theme/logo.jpg | wc -c)X\r\n')
    pump(15)
    r = dict(re.findall(r'^([NAPL])=(.*)X\s*$', buf, re.M))
    print(r)
    ok = r.get('N', '0') != '0' and '"active":false' in r.get('A', '') and r.get('P') == '1' and int(r.get('L', '0') or 0) > 1000
    print('PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)
finally:
    q.terminate()
