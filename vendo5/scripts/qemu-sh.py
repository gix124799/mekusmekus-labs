#!/usr/bin/env python3
"""Run one shell command in the QEMU guest over its serial console (see qemu-up.py) and print the output.
   python3 scripts/qemu-sh.py 'logread | tail -20'"""
import os, socket, sys, time, uuid
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build'))
s = socket.socket(socket.AF_UNIX); s.connect('serial.sock'); s.settimeout(1)
s.send(b'\r\n'); time.sleep(1)
s.send(b'root\r\n'); time.sleep(3); s.send(b'\r\n'); time.sleep(2)  # logs in when at the login prompt, harmless otherwise
s.send(('echo ST$((40+2)); ' + sys.argv[1] + '; echo EN$((40+2))\r\n').encode())
buf = ''; end = time.time() + float(os.environ.get('QSH_TIMEOUT', '120'))
while time.time() < end:
    try: buf += s.recv(65536).decode(errors='replace')
    except socket.timeout: pass
    if 'EN42' in buf: break
out = buf.replace('\r', '')
print(out.split('ST42', 1)[-1].split('EN42')[0].strip())
