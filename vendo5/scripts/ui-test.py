# Headless-Firefox click-through of portal + admin against real main.js. Needs: selenium (venv), geckodriver. Run from repo root.
import os, subprocess, tempfile, time, json, shutil
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.common.by import By
root = os.getcwd(); W = tempfile.mkdtemp(dir=root + '/build')
for pin in (11, 12): os.makedirs(f'{W}/gpio/gpio{pin}')
os.makedirs(W + '/cfg')
for f in ('export', 'unexport', 'gpio11/direction', 'gpio12/direction', 'gpio12/edge'): open(f'{W}/gpio/{f}', 'w').close()
open(W + '/gpio/gpio12/value', 'w').write('0')
for f in os.listdir('config'): shutil.copy('config/' + f, W + '/cfg')
env = dict(os.environ, VENDO5_CONFIG_DIR=W+'/cfg', VENDO5_SESSION_FILE=W+'/s.json', VENDO5_GPIO_BASE=W+'/gpio', VENDO5_PORTAL_PORT='3998', VENDO5_FIREWALL_CMD='noop', VENDO5_ARP_FAKE_MAC='aa:bb:cc:dd:ee:02')
app = subprocess.Popen(['node', 'main.js'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
o = Options(); o.add_argument('-headless')
d = webdriver.Firefox(options=o, service=Service('/snap/bin/geckodriver')); d.set_window_size(420, 900)
P = 'http://127.0.0.1:3998'; res = {}
def js_errors(): return d.execute_script('return window.__errs||[]')
try:
    d.get(P + '/'); d.execute_script("window.__errs=[];window.onerror=function(m){window.__errs.push(m)}")
    res['client loads, offline'] = d.find_element(By.ID, 'title-status').text.lower() == 'offline'
    d.find_element(By.ID, 'client-insert-coin').click(); time.sleep(.5)
    res['INSERT COIN shows toast'] = 'Insert your coin' in d.find_element(By.CLASS_NAME, 'toast').text
    open(W + '/gpio/gpio12/value', 'w').write('1'); time.sleep(3.2)
    res['client shows Online + time'] = d.find_element(By.ID, 'title-status').text.lower() == 'online' and 'm' in d.find_element(By.ID, 'client-duration').text
    d.save_screenshot(W + '/client.png'); shutil.copy(W + '/client.png', root + '/build/shot-client.png')
    d.get(P + '/admin'); res['admin shows login'] = bool(d.find_elements(By.ID, 'admin-login-form'))
    d.find_element(By.ID, 'login-username').send_keys('admin'); d.find_element(By.ID, 'login-password').send_keys('wrong')
    d.find_element(By.ID, 'login-submit').click(); time.sleep(.7)
    res['bad login shows error'] = d.find_element(By.ID, 'login-error').is_displayed()
    d.find_element(By.ID, 'login-password').clear(); d.find_element(By.ID, 'login-password').send_keys('admin')
    d.find_element(By.ID, 'login-submit').click(); time.sleep(1)
    res['good login -> dashboard w/ session'] = bool(d.find_elements(By.ID, 'logout-btn')) and 'aa:bb:cc:dd:ee:02' in d.page_source
    d.save_screenshot(root + '/build/shot-admin.png')
    d.find_element(By.ID, 'logout-btn').click(); time.sleep(1)
    res['logout -> login form'] = bool(d.find_elements(By.ID, 'admin-login-form'))
    res['no JS errors'] = js_errors() == []
finally:
    d.quit(); app.terminate()
print(json.dumps(res, indent=1)); raise SystemExit(0 if all(res.values()) else 1)
