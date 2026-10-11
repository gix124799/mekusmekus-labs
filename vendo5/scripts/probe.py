"""Open one admin page in headless Firefox with the reply recorder on and print what the page reads that we do
not provide, and every exception its callbacks threw.   python3 scripts/probe.py <page> [js-to-run-after-load]

The server is the real main.js with seeded data (vouchers, a voucher session, sales, a notice). Use it when
building a page: run it before the handlers (to see what the page wants) and after (to see nothing is MISSING).
Needs the same things as scripts/live-test.py.
"""
import json, os, subprocess, sys, tempfile, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, 'legacy', 'wifi5-soft', 'frontend-decrypted', 'public')
PORT = 3994
page = sys.argv[1] if len(sys.argv) > 1 else 'dashboard'
extra_js = sys.argv[2] if len(sys.argv) > 2 else ''
work = tempfile.mkdtemp(prefix='vendo5-probe-')
now = int(time.time() * 1000)
os.makedirs(f'{work}/gpio/gpio17')
for f in ('export', 'unexport', 'gpio17/direction', 'gpio17/edge', 'gpio17/value'):
    open(f'{work}/gpio/{f}', 'w').write('0')
json.dump({'aa:bb:cc:dd:ee:01': {'mac': 'aa:bb:cc:dd:ee:01', 'creditPesos': 5, 'expiresAt': now + 3600000, 'startedAt': now - 60000, 'type': 'pausable', 'code': 'LIVE2345', 'pauselimit': 2, 'upload': '1M', 'download': '2M'},
           '11:22:33:44:55:66': {'mac': '11:22:33:44:55:66', 'creditPesos': 1, 'expiresAt': now + 600000, 'startedAt': now - 60000}}, open(f'{work}/sessions.json', 'w'))
os.makedirs(f'{work}/state/vouchers')
v = lambda c, t='consumable': {'code': c, 'duration': 3600, 'upload': '10M', 'download': '20M', 'type': t, 'notsametype': 0, 'genfrom': 'Juan', 'price': 5, 'created': now}
json.dump({'ABC12345': v('ABC12345'), 'XYZ98765': v('XYZ98765', 'pausable')}, open(f'{work}/state/vouchers/list.json', 'w'))
json.dump({'voucher-1': {'title': 'Promo', 'price': 5, 'data': [['ABC12345', 3600, 'Juan', 5, '10M', '20M', 'consumable', 'Promo']]}}, open(f'{work}/state/vouchers/tickets.json', 'w'))
json.dump([{'ts': now - 5000, 'kind': 'coin', 'amount': 1, 'mac': 'aa:bb:cc:dd:ee:01'}, {'ts': now - 3000, 'kind': 'voucher', 'amount': 5, 'mac': 'aa:bb:cc:dd:ee:01', 'code': 'OLD11111', 'owner': 'Juan'}], open(f'{work}/state/sales.json', 'w'))
env = dict(os.environ, VENDO5_CONFIG_DIR=f'{work}/cfg', VENDO5_DEFAULTS_DIR=f'{ROOT}/config', VENDO5_SESSION_FILE=f'{work}/sessions.json', VENDO5_STATE_DIR=f'{work}/state',
           VENDO5_UI_DIR=UI, VENDO5_GPIO_BASE=f'{work}/gpio', VENDO5_PORTAL_PORT=str(PORT), VENDO5_FIREWALL_CMD='noop', VENDO5_ARP_FAKE_MAC='aa:bb:cc:dd:ee:99',
           VENDO5_PROBE_JS=os.path.join(ROOT, 'scripts', 'probe-recorder.js'))
log = f'{work}/server.log'
srv = subprocess.Popen(['node', 'main.js'], cwd=ROOT, env=env, stdout=open(log, 'a'), stderr=subprocess.STDOUT)
o = Options(); o.add_argument('-headless')
d = webdriver.Firefox(options=o, service=Service(os.environ.get('GECKODRIVER', '/snap/bin/geckodriver')))
d.set_window_size(1300, 1000)
try:
    for _ in range(40):
        if 'portal listening' in open(log).read(): break
        time.sleep(0.25)
    d.get(f'http://127.0.0.1:{PORT}/admin')
    d.find_element(By.ID, 'username').send_keys('admin'); d.find_element(By.ID, 'password').send_keys('admin'); d.find_element(By.ID, 'login-btn').click()
    for _ in range(40):
        if 'page=dashboard' in d.current_url: break
        time.sleep(0.25)
    time.sleep(2)
    d.get(f'http://127.0.0.1:{PORT}/admin?page={page}')
    time.sleep(4)
    if extra_js:
        print('JS =>', d.execute_script(extra_js)); time.sleep(2)
    rec = d.execute_script('return window.__rec || {}')
    print('MISSING:', sorted(k for k, x in rec.items() if x == 'MISSING'))
    print('ERRORS :', [e for e in d.execute_script('return window.__errs || []') if 'hg_0x5dce2f' not in e])
    shot = f'{work}/{page}.png'; d.save_screenshot(shot); print('screenshot:', shot)
    print('server errors:', [l for l in open(log).read().splitlines() if '"level":"error"' in l][:5])
finally:
    srv.terminate()
    try: d.quit()
    except Exception: pass
