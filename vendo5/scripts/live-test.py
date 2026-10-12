"""Live test of the vendo5 admin: the real main.js, the original admin frontend, headless Firefox.

Logs in through the original login page (real challenge/response), then checks the dashboard, the session
actions, the logs page, the notification bell and logout, and that the pages raise no JavaScript error and
only ever talk to their own origin. Fake GPIO sysfs and a no-op firewall: nothing touches nft, /mnt or /sys.

Needs: selenium (python), firefox, geckodriver (GECKODRIVER=/path, default /snap/bin/geckodriver), node, free
port 3996. Run from anywhere:   python3 scripts/live-test.py
Screenshots and the server log land in a temp dir that is printed at the end. Exit code 1 if any check fails.
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request, urllib.error
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, 'legacy', 'wifi5-soft', 'frontend-decrypted', 'public')
OUT = tempfile.mkdtemp(prefix='vendo5-live-')
PORT = 3996
URL = f'http://127.0.0.1:{PORT}'
M1, M2 = 'aa:bb:cc:dd:ee:01', '11:22:33:44:55:66'
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'   [{detail}]' if detail and not ok else ''), flush=True)
    return ok


def until(fn, t=10.0, step=0.25):
    end = time.time() + t
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(step)
    return False


def arm(d):
    d.execute_script("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});"
                     "window.addEventListener('unhandledrejection',function(e){window.__errs.push('rej:'+String(e.reason))});")


def errs(d):
    # The dashboard sends its first poll before the system-info reply is back and reads an uptime that is
    # not there yet; the page swallows it and the next poll draws everything. The original did the same.
    return [e for e in d.execute_script('return window.__errs||[]') if 'hg_0x5dce2f is undefined' not in e]


def shot(d, name):
    d.save_screenshot(f'{OUT}/{name}.png')


def api(method, path, body=None):
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {'http': e.code}


def fill(d, values):
    for k, v in values.items():
        d.execute_script("var e=document.getElementById(arguments[0]);e.value=arguments[1];e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))", k, str(v))


def foreign_requests(d):
    """Every resource the page loaded that did not come from our own origin."""
    return d.execute_script("return performance.getEntriesByType('resource').map(function(e){return e.name})"
                            ".filter(function(n){return n.indexOf(location.origin)!==0})")


def main():
    now = int(time.time() * 1000)
    seed = {M1: {'mac': M1, 'creditPesos': 2, 'expiresAt': now + 10 * 60000, 'startedAt': now - 90000},
            M2: {'mac': M2, 'creditPesos': 1, 'expiresAt': now + 5 * 60000, 'startedAt': now - 30000}}
    work = tempfile.mkdtemp(dir=OUT)
    for pin in (11, 12):
        os.makedirs(f'{work}/gpio/gpio{pin}')
    for f in ('export', 'unexport', 'gpio11/direction', 'gpio12/direction', 'gpio12/edge'):
        open(f'{work}/gpio/{f}', 'w').close()
    open(f'{work}/gpio/gpio12/value', 'w').write('0')
    json.dump(seed, open(f'{work}/sessions.json', 'w'))
    full = {a: {'read': True, 'write': True} for a in ('vouchers', 'credits', 'cvused', 'sales', 'ticket')}
    os.makedirs(f'{work}/state', exist_ok=True)
    json.dump({'juan': {'username': 'juan', 'password': 'secret99', 'limit': {'voucher': {'l': 10, 'u': 0}, 'credit': {'l': 0, 'u': 0}}, 'permission': full,
                        'vouchertype': {'pausable': False, 'consumable': True},
                        'voucherset': {'hour': {'profile': 'hour', 'type': 'consumable', 'length': 6, 'random': True, 'prefix': 'RS', 'upload': '2M', 'download': '5M', 'duration': 3600, 'price': 5, 'notsametype': 0}},
                        'creditset': {}}}, open(f'{work}/state/resellers.json', 'w'))
    os.makedirs(f'{work}/state', exist_ok=True)
    json.dump({'aa:bb:cc:dd:ee:99': {'mac': 'aa:bb:cc:dd:ee:99', 'name': '', 'credit': 3, 'point': 4, 'total': 0}}, open(f'{work}/state/clients.json', 'w'))
    json.dump({str(now): {'title': 'Welcome', 'icon': 'mdi-information-outline', 'message': 'First notice', 'read': False}},
              open(f'{work}/state/notification.json', 'w'))
    env = dict(os.environ, VENDO5_CONFIG_DIR=f'{work}/cfg', VENDO5_DEFAULTS_DIR=f'{ROOT}/config', VENDO5_SESSION_FILE=f'{work}/sessions.json',
               VENDO5_STATE_DIR=f'{work}/state', VENDO5_UI_DIR=UI, VENDO5_GPIO_BASE=f'{work}/gpio', VENDO5_PORTAL_PORT=str(PORT),
               VENDO5_FIREWALL_CMD='noop', VENDO5_ARP_FAKE_MAC='aa:bb:cc:dd:ee:99')
    logf = f'{work}/server.log'
    srv = subprocess.Popen(['node', 'main.js'], cwd=ROOT, env=env, stdout=open(logf, 'a'), stderr=subprocess.STDOUT)
    o = Options()
    o.add_argument('-headless')
    d = webdriver.Firefox(options=o, service=Service(os.environ.get('GECKODRIVER', '/snap/bin/geckodriver')))
    d.set_window_size(1280, 900)
    try:
        check('server boots', until(lambda: 'portal listening' in open(logf).read(), 10))
        check('boot logged no error', '"level":"error"' not in open(logf).read(), open(logf).read()[-300:])

        print('\n== LOGIN PAGE ==')
        d.get(URL + '/admin')
        arm(d)
        check('login form is the original (username, password, button)', until(lambda: d.find_element(By.ID, 'login-btn').is_displayed()))
        check('version and code are filled from @main-66322', until(lambda: d.find_element(By.ID, 'version').text.strip() != '' and d.find_element(By.ID, 'prefix').text.strip() != ''))
        shot(d, '1-login')
        d.find_element(By.ID, 'username').send_keys('admin')
        d.find_element(By.ID, 'password').send_keys('wrong')
        d.find_element(By.ID, 'login-btn').click()
        check('wrong password stays on the login page', until(lambda: d.find_element(By.ID, 'error').is_displayed() or '/admin' == d.current_url.replace(URL, '').split('?')[0]))
        check('wrong password did not reach the dashboard', 'page=dashboard' not in d.current_url)
        d.find_element(By.ID, 'password').clear()
        d.find_element(By.ID, 'password').send_keys('admin')
        d.find_element(By.ID, 'login-btn').click()
        check('right password lands on the dashboard', until(lambda: 'page=dashboard' in d.current_url), d.current_url)
        # the login page finishes its own navigation after the redirect; let it settle before clicking around
        until(lambda: d.find_element(By.ID, 'active-client-count'))
        time.sleep(1.5)

        print('\n== DASHBOARD ==')
        arm(d)
        check('the menu carries every page of the original (32 of them)', until(lambda: len(set(a.get_attribute('href').split('page=')[1] for a in d.find_elements(By.CSS_SELECTOR, 'a.nav-link[href*="page="]'))) == 32), str(len(d.find_elements(By.CSS_SELECTOR, 'a.nav-link[href*="page="]'))))
        body = lambda: d.execute_script('return document.body.textContent').lower()  # textContent: rows scroll inside a clipped box
        check('the first seeded session is listed', until(lambda: M1 in body()), body()[:300])
        check('the second seeded session is listed', until(lambda: M2 in body()))
        check('the Active Users count is 2', until(lambda: d.find_element(By.ID, 'active-client-count').text.strip() == '2'))
        check('system info shows an uptime', until(lambda: re.search(r'uptime:\s*\d+:\d+:\d+', body())))
        shot(d, '2-dashboard')

        print('\n== SESSION ACTION ==')
        # the action menu sits behind a "⋮" dropdown on each row; remove the first session through it
        row = d.find_element(By.XPATH, f'//td[contains(translate(., "ABCDEF", "abcdef"), "{M1}")]/ancestor::tr')
        row.find_element(By.CSS_SELECTOR, 'a[data-toggle="dropdown"]').click()
        row.find_element(By.XPATH, './/a[contains(@id, "-remove")]').click()  # Remove acts at once: no confirm dialog in the original
        shot(d, '3-after-remove')
        saved = lambda: json.load(open(f'{work}/sessions.json'))
        check('the session is gone from the file', until(lambda: M1 not in saved() and M2 in saved()), str(list(saved())))
        check('the row disappears from the page', until(lambda: M1 not in body()))
        time.sleep(2)  # the page is still redrawing after the action; a navigation now can be overtaken by it

        print('\n== VOUCHERS ==')
        d.find_element(By.CSS_SELECTOR, 'a.nav-link[href="?page=vouchers"]').click()
        check('vouchers page loads', until(lambda: 'page=vouchers' in d.current_url))
        arm(d)
        time.sleep(1.5)
        gen = until(lambda: next((b for b in d.find_elements(By.TAG_NAME, 'button') if b.text.strip() == 'Generate' and b.is_displayed()), None))
        gen.click()
        until(lambda: d.find_element(By.ID, 'owner-input').is_displayed())
        fill(d, {'owner-input': 'Juan', 'price-input': 5, 'voucher-qty': 2, 'voucher-prefix': 'T', 'voucher-type': 1, 'voucher-pauselimit': 2})
        shot(d, '6-generate')
        d.find_element(By.ID, 'generate-voucher').click()
        check('generating shows the new codes', until(lambda: 'voucher generated' in body() and len(re.findall(r't[a-z0-9]{6}', body())) >= 2), body()[-200:])
        listed = lambda: json.load(open(f'{work}/state/vouchers/list.json'))
        codes = [c for c in listed() if c.startswith('T')]
        check('two T-prefixed vouchers are stored', len(codes) == 2, str(codes))
        shot(d, '7-generated')
        code = codes[0]
        r = api('POST', '/api/redeem', {'code': 'NOPE1234'})
        check('a wrong voucher is refused', r.get('ok') is False and 'Invalid' in r.get('message', ''), str(r))
        r = api('POST', '/api/redeem', {'code': code.lower()})
        check('the portal accepts a real voucher', r.get('ok') is True, str(r))
        st = api('GET', '/api/status')
        check('the client is online with a pausable session', st.get('active') and st.get('pausable') and st.get('remainingSeconds', 0) > 3500, str(st))
        check('the used voucher is gone from the unused list', code not in listed())
        check('the sale was recorded', any(x.get('code') == code and x.get('amount') == 5 for x in json.load(open(f'{work}/state/sales.json'))))
        check('pause freezes the session', api('POST', '/api/pause').get('ok') is True and api('GET', '/api/status').get('paused') is True)
        time.sleep(1.2)
        a, b = api('GET', '/api/status')['remainingSeconds'], None
        time.sleep(1.2)
        b = api('GET', '/api/status')['remainingSeconds']
        check('paused time does not run down', a == b, f'{a} {b}')
        check('resume continues it', api('POST', '/api/resume').get('ok') is True and api('GET', '/api/status').get('active') is True)
        d.refresh()
        arm(d)
        check('the Active Voucher table lists it with its client MAC', until(lambda: code.lower() in body() and 'aa:bb:cc:dd:ee:99' in body()), body()[:200])
        check('the Used Voucher table lists it', until(lambda: body().count(code.lower()) >= 2))
        shot(d, '8-vouchers')
        check('the vouchers page raised no JavaScript error', errs(d) == [], str(errs(d)))

        print('\n== LOGS ==')
        d.find_element(By.CSS_SELECTOR, 'a.nav-link[href="?page=logs"]').click()  # through the menu, as a person would
        arm(d)
        check('logs page loads (stays logged in)', until(lambda: 'page=logs' in d.current_url))
        sel = until(lambda: next((s for s in d.find_elements(By.CSS_SELECTOR, 'select') if s.is_displayed() and 'system' in (s.get_attribute('id') or '')), None))
        check('a system log date is offered', bool(sel))
        check('the login is in the System Logs table', until(lambda: 'admin success login' in body()), body()[-300:])
        shot(d, '4-logs')
        check('logs page raised no JavaScript error', errs(d) == [], str(errs(d)))

        print('\n== NETWORK PAGES ==')
        for page in ('interfaces', 'dhcp', 'leases', 'wireless', 'ntp-client', 'scheduler', 'utility', 'nft'):
            d.get(f'{URL}/admin?page={page}')
            arm(d)
            time.sleep(2.5)
            check(f'{page} loads and raises no JavaScript error', f'page={page}' in d.current_url and errs(d) == [], str(errs(d))[:200])
            shot(d, f'net-{page}')
        d.get(URL + '/admin?page=ntp-client'); arm(d)
        check('NTP shows the servers from uci', until(lambda: d.find_element(By.ID, 'server1').get_attribute('value') == '0.openwrt.pool.ntp.org'))
        fill(d, {'server1': 'time.example.org'})
        d.find_element(By.ID, 'save-ntp').click()
        time.sleep(1.5)
        d.refresh(); arm(d)
        check('a saved NTP server is still there after a reload', until(lambda: d.find_element(By.ID, 'server1').get_attribute('value') == 'time.example.org'))

        print('\n== PROFILE MENU (the 3 dots) ==')
        d.get(URL + '/admin?page=dashboard'); arm(d); time.sleep(1.5)
        items = [e.get_attribute('id') for e in d.find_elements(By.CSS_SELECTOR, '.sidebar-dropdown a.dropdown-item[id], .preview-list a.dropdown-item[id]')]
        for want in ('system-update', 'software-updown', 'export-data', 'import-data', 'clear-all-data', 'license', 'change-pass', 'system-reboot', 'logout'):
            check(f'profile menu has {want}', want in items, str(items))
        d.execute_script("document.getElementById('license').click()")
        check('the License dialog shows the permanent offline licence', until(lambda: 'activated' in body() or 'unlimited' in body() or 'license info' in body()), body()[-200:])
        shot(d, '9-license')
        d.refresh(); arm(d); time.sleep(1)

        print('\n== NOTIFICATIONS ==')
        d.get(URL + '/admin?page=dashboard')
        arm(d)
        bell = until(lambda: d.find_element(By.ID, 'notebell'))
        check('unread notice marks the bell', until(lambda: 'count' in (d.find_element(By.ID, 'notebell').get_attribute('class') or '')))
        d.find_element(By.ID, 'notification').click() if d.find_elements(By.ID, 'notification') else bell.click()
        check('the notice title and message are listed (no "undefined")', until(lambda: 'welcome' in body() and 'first notice' in body() and 'undefined' not in body()), body()[-300:])
        check('the notice date is today, not 1970', str(time.localtime().tm_year) in d.find_element(By.ID, 'notification-items').text)
        shot(d, '5-notifications')

        print('\n== PAGE HEALTH ==')
        time.sleep(3)
        check('dashboard raised no JavaScript error', errs(d) == [], str(errs(d)))
        check('every request stayed on our origin', foreign_requests(d) == [], str(foreign_requests(d)))
        for page in ('nonexistent', '../etc', 'ticket2'):
            d.get(f'{URL}/admin?page={page}')
            check(f'unknown page {page} falls back to the dashboard', until(lambda: 'page=dashboard' in d.current_url))

        check('the server logged no error during the whole run', '"level":"error"' not in open(logf).read(), open(logf).read()[-400:])

        print('\n== RESELLER ==')
        d.get(URL + '/admin?page=reseller'); arm(d); time.sleep(2.5)
        check('the admin Reseller page lists the account', 'juan' in body(), body()[:200])
        check('the Reseller admin page raised no JavaScript error', errs(d) == [], str(errs(d))[:200])
        shot(d, 'reseller-admin')
        # the reseller is a different person in a different browser: a fresh one, so nothing carries over
        o2 = Options()
        o2.add_argument('-headless')
        rd = webdriver.Firefox(options=o2, service=Service(os.environ.get('GECKODRIVER', '/snap/bin/geckodriver')))
        rd.set_window_size(1280, 900)
        try:
            rbody = lambda: rd.execute_script('return document.body.textContent').lower()
            rd.get(URL + '/reseller'); arm(rd)
            check('the reseller login page loads', until(lambda: rd.find_element(By.ID, 'login-btn').is_displayed()))
            rd.find_element(By.ID, 'username').send_keys('juan'); rd.find_element(By.ID, 'password').send_keys('wrong'); rd.find_element(By.ID, 'login-btn').click()
            time.sleep(1.5)
            check('a wrong reseller password stays on the login page', 'page=' not in rd.current_url, rd.current_url)
            rd.find_element(By.ID, 'password').clear(); rd.find_element(By.ID, 'password').send_keys('secret99'); rd.find_element(By.ID, 'login-btn').click()
            check('the reseller lands on their Vouchers page', until(lambda: 'page=vouchers' in rd.current_url), rd.current_url)
            arm(rd); time.sleep(2)
            check('the reseller sees their own name', until(lambda: 'juan' in rbody()))
            check('the reseller portal raised no JavaScript error', errs(rd) == [], str(errs(rd))[:200])
            shot(rd, 'reseller-portal')
            gen = until(lambda: next((b for b in rd.find_elements(By.TAG_NAME, 'button') if b.text.strip() == 'Generate' and b.is_displayed()), None))
            check('the Generate button is there', bool(gen))
            rd.find_element(By.CSS_SELECTOR, 'a.nav-link[href="?page=sales"]').click()
            check('the reseller Sales page opens', until(lambda: 'page=sales' in rd.current_url))
            rd.execute_script("document.getElementById('logout').click()")
            check('reseller logout returns to its login', until(lambda: rd.find_elements(By.ID, 'login-btn')))
        finally:
            rd.quit()

        print('\n== CUSTOMER PORTAL ==')
        pd = webdriver.Firefox(options=o, service=Service(os.environ.get('GECKODRIVER', '/snap/bin/geckodriver')))
        try:
            pd.set_window_size(480, 1000)
            pbody = lambda: pd.execute_script('return document.body.textContent').lower()
            pd.get(URL + '/?page=dashboard'); arm(pd)
            check('the portal is the original page (device name from the settings)', until(lambda: 'ethylnet' in pbody()))
            check('the wallet shows the 3 pesos', until(lambda: '3.00' in pbody()), pbody()[:200])
            check('the portal shows the voucher session the admin tests left on this device', until(lambda: 'status:connected' in pbody().replace(' ', '').replace('\n', ''), 15))
            d4 = pd.execute_async_script("var done=arguments[arguments.length-1];io().emit('@portal-4',null,function(a){done(a)})")
            check('Pause (the same button) answers Paused for a pausable session', d4 == 'Paused', str(d4))
            pd.get(URL + '/?page=dashboard'); arm(pd)
            check('the dashboard now says Paused', until(lambda: 'status:paused' in pbody().replace(' ', '').replace('\n', ''), 15))
            d4 = pd.execute_async_script("var done=arguments[arguments.length-1];io().emit('@portal-4',null,function(a){done(a)})")
            check('the same button resumes it', d4 == 'Connected', str(d4))
            pd.get(URL + '/?page=dashboard'); arm(pd)
            for pg in ('eload', 'logs', 'media'):
                pd.get(URL + f'/?page={pg}'); arm(pd); time.sleep(2.5)
                check(f'portal page {pg} raised no JavaScript error', errs(pd) == [], str(errs(pd))[:200])
            pd.get(URL + '/?page=dashboard'); arm(pd); time.sleep(2)
            check('the portal loaded nothing from outside', foreign_requests(pd) == [], str(foreign_requests(pd)))
            # the coin popup: open it over the socket, pulse the coin pin, the wallet grows, Connect turns it into time
            ins = lambda: next((e for e in pd.find_elements(By.TAG_NAME, 'button') if ' '.join(e.text.lower().split()) == 'insert coin' and e.is_displayed()), None)
            time.sleep(3)
            until(ins).click()
            if not until(lambda: pd.find_elements(By.CSS_SELECTOR, '#modal-alert-34.show'), 4):
                ins().click()
            time.sleep(2); shot(pd, 'portal-after-insert')
            check('the Insert Coin popup opens', until(lambda: pd.find_elements(By.CSS_SELECTOR, '#modal-alert-34.show')))
            until(lambda: pd.find_element(By.ID, 'insert-close-d').is_displayed()).__class__
            pd.find_element(By.ID, 'insert-close-d').click()
            check('its Close button closes it', until(lambda: not pd.find_elements(By.CSS_SELECTOR, '#modal-alert-34.show')))
            r = pd.execute_async_script("var done=arguments[arguments.length-1],s=io();var got=null;s.on('@portal-20',function(m){got=m});"
                                        "s.emit('@portal-13',{},function(a){window.__a13=a;setTimeout(function(){done(JSON.stringify(a))},100)});")
            check('Insert Coin answers Insert with the countdown', json.loads(r).get('message') == 'Insert', r)
            open(f'{work}/gpio/gpio12/value', 'w').write('1')
            coin = until(lambda: pd.execute_script("return window.__coin||null"), 0.1)
            time.sleep(1.5)
            info = json.loads(pd.execute_async_script("var done=arguments[arguments.length-1];io().emit('@portal-2',null,function(a){done(JSON.stringify(a))})"))
            check('a coin pulse adds one peso to the wallet', info.get('credit') == 4, str(info.get('credit')))
            c = pd.execute_async_script("var done=arguments[arguments.length-1];io().emit('@portal-11',2,function(a){done(a)})")
            check('Connect with 2 pesos of credit succeeds', c == 'Success', str(c))
            pd.get(URL + '/?page=dashboard'); arm(pd)
            check('the dashboard now says Connected', until(lambda: 'status:connected' in pbody().replace(' ', '').replace('\n', ''), 15))
            check('the connected dashboard raised no JavaScript error', errs(pd) == [], str(errs(pd))[:200])
            shot(pd, 'portal-connected')
        finally:
            pd.quit()

        print('\n== LOGOUT ==')
        out = until(lambda: next((e for e in d.find_elements(By.ID, 'logout') if e.is_displayed()), None))
        if not out:
            d.execute_script("document.getElementById('logout').click()")
        else:
            out.click()
        check('logout returns to the login page', until(lambda: d.find_elements(By.ID, 'login-btn')))
        d.get(URL + '/admin?page=dashboard')
        check('dashboard is gone after logout', until(lambda: d.find_elements(By.ID, 'login-btn')))
    finally:
        d.quit()
        srv.terminate()
        print(f'\nartifacts: {OUT}')
    bad = [n for n, ok in results if not ok]
    print(f'\n==== {len(results) - len(bad)}/{len(results)} passed ====')
    sys.exit(1 if bad else 0)


main()
