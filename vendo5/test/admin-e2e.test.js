// The real main.js, booted as a process: factory login, dashboard data, a session action, the log it wrote.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { io: connect } = require('socket.io-client');

const MAIN = path.join(__dirname, '..', 'main.js');
const UI = require('./helpers/ui-root');
const MAC = 'aa:bb:cc:dd:ee:01';
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(UI, 'main', 'js', 'md5.js'), 'utf8'), sandbox);

const waitFor = async (get, re) => { for (let i = 0; i < 160 && !re.test(get()); i++) await new Promise((x) => setTimeout(x, 50)); };
const req = (port, method, p, { cookie, body, type } = {}) => new Promise((resolve, reject) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = type;
  const q = http.request({ port, method, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  q.on('error', reject);
  q.end(body);
});
const ask = (c, id, payload) => new Promise((resolve) => (payload === undefined ? c.emit(id, resolve) : c.emit(id, payload, resolve)));

async function boot(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5e2e-'));
  const stateDir = path.join(root, 'state');
  const sessionFile = path.join(root, 'sessions.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ [MAC]: { mac: MAC, creditPesos: 2, expiresAt: Date.now() + 600000, startedAt: Date.now() - 60000 } }));
  const gpio = path.join(root, 'gpio');
  for (const pin of [11, 12]) {
    fs.mkdirSync(path.join(gpio, `gpio${pin}`), { recursive: true });
    for (const field of ['value', 'direction', ...(pin === 12 ? ['edge'] : [])]) fs.writeFileSync(path.join(gpio, `gpio${pin}`, field), '0');
  }
  for (const f of ['export', 'unexport']) fs.writeFileSync(path.join(gpio, f), '0');
  const p = spawn(process.execPath, [MAIN], { env: { ...process.env, VENDO5_CONFIG_DIR: path.join(root, 'cfg'), VENDO5_DEFAULTS_DIR: path.join(__dirname, '..', 'config'), VENDO5_SESSION_FILE: sessionFile, VENDO5_STATE_DIR: stateDir, VENDO5_UI_DIR: UI, VENDO5_GPIO_BASE: gpio, VENDO5_PORTAL_PORT: '0', VENDO5_FIREWALL_CMD: 'noop', ...extraEnv } });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  const stop = () => p.kill('SIGKILL');
  await waitFor(() => out, /portal listening/);
  const line = /^.*"portal listening".*$/m.exec(out);
  if (!line) { stop(); throw new Error('server did not start:\n' + out); }
  return { port: JSON.parse(line[0]).port, stateDir, sessionFile, gpio, out: () => out, stop };
}

async function login(port, user, pass) {
  const cookie = (await req(port, 'GET', '/admin')).headers['set-cookie'][0].split(';')[0];
  const sock = await new Promise((resolve, reject) => {
    const c = connect('http://127.0.0.1:' + port, { path: '/admin', reconnection: false, extraHeaders: { cookie } });
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
  const token = await ask(sock, '@main-48931');
  const h = (token.length - 1) / 2;
  const reply = await ask(sock, '@main-66589', {
    uname: user,
    username: sandbox.hexMD5(token.substring(0, h) + user.toLowerCase()),
    password: sandbox.hexMD5(token.substring(h, token.length) + pass),
  });
  return { sock, cookie, reply };
}

test('factory login works, the dashboard lists the paid session, remove ends it, the log records it', async () => {
  const s = await boot();
  try {
    assert.match(s.out(), /factory default/);
    const { sock, cookie, reply } = await login(s.port, 'admin', 'admin');
    assert.deepEqual(reply, { login: true });
    assert.equal((await req(s.port, 'POST', '/admin', { cookie, body: '', type: 'application/x-www-form-urlencoded' })).headers.location, '/admin?page=dashboard');
    const dash = await ask(sock, '@nav-89554', { getSessionList: true });
    assert.deepEqual(Object.keys(dash.active.session), [MAC]);
    assert.ok(dash.active.data[MAC].expiration > Date.now());
    assert.equal(await ask(sock, '@nav-44232', { mac: MAC }), 'Success');
    assert.deepEqual(Object.keys((await ask(sock, '@nav-89554', {})).active.session), []);
    await waitFor(() => (fs.existsSync(s.sessionFile) ? fs.readFileSync(s.sessionFile, 'utf8') : '{"x":1}'), /^\{\}$/);
    assert.equal(fs.readFileSync(s.sessionFile, 'utf8'), '{}', 'the removal is persisted');
    const files = await ask(sock, '@nav-645798');
    assert.equal(files.length, 1);
    const text = await ask(sock, '@nav-636547', files[0]);
    assert.match(text, /Admin Success Login: user admin from/);
    assert.match(text, new RegExp(`Admin removed session ${MAC}`));
    sock.close();
  } finally { s.stop(); }
});

test('the wrong password never opens the admin events', async () => {
  const s = await boot();
  try {
    const { sock, reply } = await login(s.port, 'admin', 'nope');
    assert.deepEqual(reply, { login: false });
    const gone = new Promise((r) => sock.on('disconnect', r));
    sock.emit('@nav-89554', {}, () => assert.fail('answered an unauthenticated dashboard request'));
    await gone;
  } finally { s.stop(); }
});

test('the captive portal still answers every other path', async () => {
  const s = await boot();
  try {
    const home = await req(s.port, 'GET', '/generate_204');
    assert.equal(home.status, 200);
    assert.match(home.body, /client\/script\/dashboard\.js/);
    assert.equal((await req(s.port, 'GET', '/main/js/md5.js')).status, 200);
    assert.equal((await req(s.port, 'GET', '/admin/')).headers.location, '/admin?page=dashboard');
  } finally { s.stop(); }
});

test('an unusable state dir or missing UI files leave the captive portal running without /admin', async () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5blk-')), 'file');
  fs.writeFileSync(blocker, 'x');
  const s = await boot({ VENDO5_STATE_DIR: path.join(blocker, 'state') });
  try {
    assert.match(s.out(), /admin page unavailable/);
    const r = await req(s.port, 'GET', '/admin');
    assert.equal(r.status, 200);
    assert.match(r.body, /client-insert-coin/, '/admin falls through to the portal page');
  } finally { s.stop(); }
});

test('the dashboard works with the fixed-MAC test ARP too (it has no neighbour table)', async () => {
  const s = await boot({ VENDO5_ARP_FAKE_MAC: 'aa:bb:cc:dd:ee:99' });
  try {
    const { sock } = await login(s.port, 'admin', 'admin');
    const dash = await ask(sock, '@nav-89554', {});
    assert.deepEqual(Object.keys(dash.active.session), [MAC]);
    assert.ok(!/"level":"error"/.test(s.out()), s.out());
    sock.close();
  } finally { s.stop(); }
});

test('every enabled page is served to a logged-in admin, and a disabled one bounces to the dashboard', async () => {
  const s = await boot();
  try {
    const { sock, cookie } = await login(s.port, 'admin', 'admin');
    await req(s.port, 'POST', '/admin', { cookie, body: '', type: 'application/x-www-form-urlencoded' });
    for (const page of ['dashboard', 'logs', 'vouchers', 'settings']) {
      const r = await req(s.port, 'GET', `/admin?page=${page}`, { cookie });
      assert.equal(r.status, 200, page);
      assert.ok(r.body.includes(`script/${page}.js`), page);
    }
    const hidden = await req(s.port, 'GET', '/admin?page=nonexistent', { cookie });
    assert.equal(hidden.status, 302);
    assert.equal(hidden.headers.location, '/admin?page=dashboard');
    sock.close();
  } finally { s.stop(); }
});

test('a coin is written to the system log the admin reads', async () => {
  const s = await boot({ VENDO5_ARP_FAKE_MAC: 'aa:bb:cc:dd:ee:77' });
  try {
    assert.equal((await req(s.port, 'POST', '/api/pay-intent', { body: '{}', type: 'application/json' })).status, 200);
    fs.writeFileSync(path.join(s.gpio, 'gpio12', 'value'), '1');
    await waitFor(() => s.out(), /Coin: 1 peso\(s\) credited to aa:bb:cc:dd:ee:77/);
    const { sock } = await login(s.port, 'admin', 'admin');
    const files = await ask(sock, '@nav-645798');
    const text = await ask(sock, '@nav-636547', files[0]);
    assert.match(text, /Coin: 1 peso\(s\) credited to aa:bb:cc:dd:ee:77/);
    sock.close();
  } finally { s.stop(); }
});

test('a coin follows the rate table the admin set, and earns the points the rules say', async () => {
  const s = await boot({ VENDO5_ARP_FAKE_MAC: 'aa:bb:cc:dd:ee:55' });
  try {
    const { sock } = await login(s.port, 'admin', 'admin');
    const add = await ask(sock, '@nav-22126', { action: 'add-config', id: 'main', coin: 1, minute: 300, config: { type: 'pausable', upload: '2M', download: '3M', pauselimit: 2 } });
    assert.equal(add.config.rate.length, 1);
    assert.equal(await ask(sock, '@nav-0092734', { action: 'SET', path: 'vendo', coin: 1, point: 2.5 }), '');
    assert.equal((await req(s.port, 'POST', '/api/pay-intent', { body: '{}', type: 'application/json' })).status, 200);
    fs.writeFileSync(path.join(s.gpio, 'gpio12', 'value'), '1');
    await waitFor(() => fs.readFileSync(s.sessionFile, 'utf8'), /aa:bb:cc:dd:ee:55/);
    const saved = JSON.parse(fs.readFileSync(s.sessionFile, 'utf8'))['aa:bb:cc:dd:ee:55'];
    assert.ok(Math.abs(saved.expiresAt - Date.now() - 300000) < 5000, '1 peso = 300 seconds from the table, not the flat rate');
    assert.deepEqual([saved.type, saved.upload, saved.download, saved.pauselimit], ['pausable', '2M', '3M', 2]);
    const info = (await ask(sock, '@nav-77833')).client.clientInfo.aabbccddee55;
    assert.deepEqual([info.total, info.point], [1, 2.5]);
    sock.close();
  } finally { s.stop(); }
});
