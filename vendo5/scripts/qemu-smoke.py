#!/usr/bin/env python3
"""Boot a test image in QEMU and verify the portal through its port-80 guest listener."""
import json
import os
import re
import select
import shutil
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')
B = '../reference/orangepi-one-original/original-firmware/boot-fat16'
source = os.environ.get('VENDO5_TEST_IMAGE', 'build/vendo5-orangepi-one-test.img')
if not os.path.isabs(source):
    source = os.path.join(ROOT, source)
os.makedirs(BUILD, exist_ok=True)
image = os.path.join(BUILD, 'qemu-run.img')
shutil.copy(source, image)

# The guest is a disposable copy; clear only its root password for the serial-console smoke test.
disk = f'{image}?offset=69206016'
shadow = subprocess.check_output(['debugfs', '-R', 'cat /etc/shadow', disk], text=True, stderr=subprocess.DEVNULL)
shadow_path = os.path.join(BUILD, 'qemu-shadow.tmp')
with open(shadow_path, 'w') as f:
    f.write(re.sub(r'^root:[^:]*:', 'root::', shadow, flags=re.M))
subprocess.run(['debugfs', '-w', '-R', 'rm /etc/shadow', disk], check=True, capture_output=True)
subprocess.run(['debugfs', '-w', '-R', f'write {shadow_path} /etc/shadow', disk], check=True, capture_output=True)
os.remove(shadow_path)
subprocess.run(['qemu-img', 'resize', '-f', 'raw', image, '2G'], check=True, capture_output=True)

serial_path = os.path.join(BUILD, 'serial.log')
open(serial_path, 'w').close()
serial = socket.socket()
q = subprocess.Popen([
    'qemu-system-arm', '-M', 'orangepi-pc', '-m', '1024', '-display', 'none', '-monitor', 'none',
    '-serial', 'tcp:127.0.0.1:5555,server=on,wait=off', '-kernel', B + '/uImage', '-dtb', B + '/dtb',
    '-append', 'console=ttyS0,115200 root=/dev/mmcblk0p2 rootwait',
    '-drive', f'file={image},if=sd,format=raw', '-nic', 'user',
], cwd=BUILD, stderr=open(os.path.join(BUILD, 'qemu.err'), 'w'))
buf = ''

def pump_for(seconds):
    global buf
    end = time.monotonic() + seconds
    with open(serial_path, 'a') as log:
        while time.monotonic() < end:
            ready, _, _ = select.select([serial], [], [], min(0.5, end - time.monotonic()))
            if not ready:
                continue
            data = serial.recv(4096).decode(errors='replace')
            if not data:
                raise RuntimeError('QEMU serial console disconnected')
            buf += data
            log.write(data)

def wait_for(pattern, timeout, description):
    end = time.monotonic() + timeout
    while not re.search(pattern, buf.replace('\r', '')):
        if q.poll() is not None:
            raise RuntimeError(f'QEMU exited before {description} (status {q.returncode})')
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f'timed out waiting for {description}')
        pump_for(min(1, remaining))

try:
    deadline = time.monotonic() + 60
    while True:
        try:
            serial.connect(('127.0.0.1', 5555))
            break
        except OSError:
            if q.poll() is not None:
                raise RuntimeError(f'QEMU exited before opening serial console (status {q.returncode})')
            if time.monotonic() >= deadline:
                raise TimeoutError('QEMU serial console did not open')
            time.sleep(0.5)
    serial.setblocking(False)
    wait_for(r'Please press Enter to activate this console\.|login:', 1200, 'guest console')
    if 'Please press Enter to activate this console.' in buf:
        serial.sendall(b'\r\n')
    wait_for(r'login:|root@[^\r\n]*[#$]\s*$', 30, 'login prompt')
    if re.search(r'login:', buf) and not re.search(r'root@[^\r\n]*[#$]\s*$', buf):
        serial.sendall(b'root\r\n')
        wait_for(r'Password:|root@[^\r\n]*[#$]\s*$', 15, 'root login')
        if re.search(r'Password:', buf) and not re.search(r'root@[^\r\n]*[#$]\s*$', buf):
            serial.sendall(b'\r\n')
            wait_for(r'root@[^\r\n]*[#$]\s*$', 15, 'root shell')

    checks = [
        ('api=$(wget -qO- -T 5 http://10.0.0.1/api/status 2>/dev/null); '
         'printf "V5_API=%s|V5_API_END\\n" "$api"', r'(?m)^V5_API=.*\|V5_API_END$'),
        ('printf "V5_PAGE=%s|V5_PAGE_END\\n" "$(wget -qO- -T 5 http://10.0.0.1/ '
         '2>/dev/null | grep -c client-insert-coin)"', r'(?m)^V5_PAGE=.*\|V5_PAGE_END$'),
        ('printf "V5_ADMIN=%s|V5_ADMIN_END\\n" "$(wget -qO- -T 5 '
         'http://10.0.0.1/admin 2>/dev/null | wc -c)"', r'(?m)^V5_ADMIN=.*\|V5_ADMIN_END$'),
        ('printf "V5_LOGO=%s|V5_LOGO_END\\n" "$(wget -qO- -T 5 '
         'http://10.0.0.1/theme/logo.jpg 2>/dev/null | wc -c)"', r'(?m)^V5_LOGO=.*\|V5_LOGO_END$'),
        ('echo V5_DIAG_BEGIN', r'(?m)^V5_DIAG_BEGIN$'),
        ('ps', None),
        ('logread | grep -E "nginx|vendo5" | tail -30', None),
        ('echo V5_DIAG_END', r'(?m)^V5_DIAG_END$'),
    ]
    for command, marker_pattern in checks:
        if len(command) > 200:
            raise RuntimeError(f'QEMU console command exceeds the safe line length: {command}')
        serial.sendall((command + '\r\n').encode())
        if marker_pattern:
            wait_for(marker_pattern, 30, f'{command} route check')
    normalized = buf.replace('\r', '')
    results = {}
    for key in ('API', 'PAGE', 'ADMIN', 'LOGO'):
        match = re.search(rf'(?m)^V5_{key}=([^\n]*)\|V5_{key}_END$', normalized)
        if not match:
            raise RuntimeError(f'missing {key} result from guest console')
        results[key] = match.group(1).strip()
    api = json.loads(results['API']) if results['API'] else {}
    result = {
        'api_active': api.get('active'),
        'api_bytes': len(results['API']),
        'portal_marker': results['PAGE'] == '1',
        'admin_bytes': int(results['ADMIN'] or '0'),
        'logo_bytes': int(results['LOGO'] or '0'),
    }
    print(json.dumps(result, indent=2))
    ok = (
        result['api_active'] is False
        and result['portal_marker']
        and result['admin_bytes'] > 0
        and result['logo_bytes'] > 1000
    )
    print('PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)
finally:
    serial.close()
    q.terminate()
    try:
        q.wait(timeout=10)
    except subprocess.TimeoutExpired:
        q.kill()
        q.wait()
