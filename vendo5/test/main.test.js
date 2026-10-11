const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const MAIN = path.join(__dirname, '..', 'main.js');
const DEFAULTS = path.join(__dirname, '..', 'config');

function run(env) {
  const p = spawn(process.execPath, [MAIN], { env: { ...process.env, ...env } });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  return { p, exited, out: () => out };
}
// Poll the child's stdout (up to 8s, no throw) instead of fixed sleeps: fixed sleeps race on a loaded machine.
const waitFor = async (r, re) => { for (let i = 0; i < 160 && !re.test(r.out()); i++) await new Promise((x) => setTimeout(x, 50)); };
const tmpDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5main-')), 'cfg');

// Task 5 added real-hardware gpio.exportPin to main.js's startup path; any
// test that reaches that far now needs a fake sysfs dir (matching the
// default vendo.json's coin_pin: 17), same as the dedicated portal test below.
function fakeGpioBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v5gpiobase-'));
  fs.writeFileSync(path.join(base, 'export'), '');
  fs.writeFileSync(path.join(base, 'unexport'), '');
  const pinDir = path.join(base, 'gpio17');
  fs.mkdirSync(pinDir, { recursive: true });
  fs.writeFileSync(path.join(pinDir, 'value'), '0');
  fs.writeFileSync(path.join(pinDir, 'direction'), '');
  fs.writeFileSync(path.join(pinDir, 'edge'), '');
  return base;
}

test('starts, logs startup line, exits 0 on SIGTERM', async () => {
  const r = run({
    VENDO5_CONFIG_DIR: tmpDir(),
    VENDO5_DEFAULTS_DIR: DEFAULTS,
    VENDO5_GPIO_BASE: fakeGpioBase(),
    VENDO5_PORTAL_PORT: '0',
  });
  await new Promise((res) => r.p.stdout.once('data', res));
  assert.match(r.out(), /"message":"vendo5 started"/);
  r.p.kill('SIGTERM');
  assert.equal(await r.exited, 0);
  assert.match(r.out(), /"message":"vendo5 stopping"/);
});

test('bad config: logs error line and exits 1', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendo.json'), '{}');
  const r = run({ VENDO5_CONFIG_DIR: dir, VENDO5_DEFAULTS_DIR: DEFAULTS });
  assert.equal(await r.exited, 1);
  assert.match(r.out(), /"level":"error".*(licensing|network|vendo)\.json/);
});

test('vendo config missing pricing fields fails startup (extends required-key validation)', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  // seed network.json/licensing.json from defaults so only vendo.json is
  // incomplete — otherwise the file-missing check for an unrelated config
  // (checked first) fires before vendo's own required-key check does.
  for (const f of fs.readdirSync(DEFAULTS)) fs.copyFileSync(path.join(DEFAULTS, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'vendo.json'), JSON.stringify({ coin_pin: 17 }));
  const r = run({ VENDO5_CONFIG_DIR: dir, VENDO5_DEFAULTS_DIR: DEFAULTS });
  assert.equal(await r.exited, 1);
  assert.match(r.out(), /"level":"error".*vendo\.json/);
});

test('portal listens and serves the landing page; coin pulse with no pay-intent is refused and logged', async () => {
  const configDir = tmpDir();
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5sessfile-')), 'sessions.json');
  const gpioBase = fs.mkdtempSync(path.join(os.tmpdir(), 'v5gpiobase-'));
  fs.writeFileSync(path.join(gpioBase, 'export'), '');
  fs.writeFileSync(path.join(gpioBase, 'unexport'), '');
  const pinDir = path.join(gpioBase, 'gpio17');
  fs.mkdirSync(pinDir, { recursive: true });
  fs.writeFileSync(path.join(pinDir, 'value'), '0');
  fs.writeFileSync(path.join(pinDir, 'direction'), '');
  fs.writeFileSync(path.join(pinDir, 'edge'), '');

  const r = run({
    VENDO5_CONFIG_DIR: configDir,
    VENDO5_DEFAULTS_DIR: DEFAULTS,
    VENDO5_SESSION_FILE: sessionFile,
    VENDO5_GPIO_BASE: gpioBase,
    VENDO5_PORTAL_PORT: '0', // ephemeral; main.js logs the actual bound port
    VENDO5_FIREWALL_CMD: 'noop',
  });
  await new Promise((res) => r.p.stdout.once('data', res));
  // settle: the first stdout line doesn't guarantee the gpio fs.watch
  // (inotify) registration is live yet; without this the write below
  // races the watcher setup and the pulse is silently missed.
  await waitFor(r, /portal listening/); // gpio watcher is registered before the listening event

  // trigger a coin pulse with no pending pay-intent
  fs.writeFileSync(path.join(pinDir, 'value'), '1');
  await waitFor(r, /orphan/);

  r.p.kill('SIGTERM');
  await r.exited;
  assert.match(r.out(), /"level":"warn".*orphan/i);
});

// Spec's Testing section (sub-project #2 design): "a smoke test that
// simulates a paid pulse and asserts a firewall-allow call happened and
// the session file was written." Missing from the plan's own Task 5 test
// (code review Important #9) — added here as a regression guard.
test('a paid coin pulse credits the session, calls firewall allow, and persists to disk', async () => {
  const configDir = tmpDir();
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5sessfile-')), 'sessions.json');
  const gpioBase = fs.mkdtempSync(path.join(os.tmpdir(), 'v5gpiobase-'));
  fs.writeFileSync(path.join(gpioBase, 'export'), '');
  fs.writeFileSync(path.join(gpioBase, 'unexport'), '');
  const pinDir = path.join(gpioBase, 'gpio17');
  fs.mkdirSync(pinDir, { recursive: true });
  fs.writeFileSync(path.join(pinDir, 'value'), '0');
  fs.writeFileSync(path.join(pinDir, 'direction'), '');
  fs.writeFileSync(path.join(pinDir, 'edge'), '');
  const mac = 'aa:bb:cc:dd:ee:ff';

  const r = run({
    VENDO5_CONFIG_DIR: configDir,
    VENDO5_DEFAULTS_DIR: DEFAULTS,
    VENDO5_SESSION_FILE: sessionFile,
    VENDO5_GPIO_BASE: gpioBase,
    VENDO5_PORTAL_PORT: '0',
    VENDO5_FIREWALL_CMD: 'noop',
    VENDO5_ARP_FAKE_MAC: mac,
  });
  await new Promise((res) => r.p.stdout.once('data', res));
  await waitFor(r, /portal listening/); // gpio watcher settle, see orphan test above

  const portLine = /"message":"portal listening".*"port":(\d+)|"port":(\d+).*"message":"portal listening"/.exec(r.out());
  const port = Number(portLine[1] || portLine[2]);
  await new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'POST', path: '/api/pay-intent' }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end();
  });

  fs.writeFileSync(path.join(pinDir, 'value'), '1'); // coin pulse
  await waitFor(r, /firewall allow/);

  r.p.kill('SIGTERM');
  await r.exited;
  assert.match(r.out(), new RegExp(`"level":"info".*"message":"firewall allow".*${mac}|"mac":"${mac}".*"message":"firewall allow"`));
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(saved[mac].creditPesos, 1);
});

// Caught a real bug: main.js passed config.admin straight to
// createAdminAuth, but the config key is password_hash (snake_case,
// matching the config-file convention) while lib/admin.js expects
// passwordHash (camelCase) -- the mismatch meant every login silently
// failed. Unit tests never caught it because they inject a fake
// adminAuth; only an end-to-end run of the real main.js wiring does.
test('admin login with the default config credentials actually works end to end', async () => {
  const r = run({ VENDO5_CONFIG_DIR: tmpDir(), VENDO5_DEFAULTS_DIR: DEFAULTS, VENDO5_GPIO_BASE: fakeGpioBase(), VENDO5_PORTAL_PORT: '0' });
  await new Promise((res) => r.p.stdout.once('data', res));
  await waitFor(r, /portal listening/);
  const portLine = /"port":(\d+)/.exec(r.out());
  const port = Number(portLine[1]);

  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ port, method: 'POST', path: '/admin/login', headers: { 'Content-Type': 'application/json' } }, (resp) => {
        let body = '';
        resp.on('data', (c) => { body += c; });
        resp.on('end', () => resolve({ body }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ username: 'admin', password: 'admin' }));
    });
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  } finally {
    r.p.kill('SIGTERM');
    await r.exited;
  }
});

test('main.js keeps serving the portal when the coin gpio pin is unavailable', async () => {
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo5-nogpio-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'main.js')], {
    env: { ...process.env, VENDO5_CONFIG_DIR: path.join(dir, 'cfg'), VENDO5_DEFAULTS_DIR: path.join(__dirname, '..', 'config'),
      VENDO5_SESSION_FILE: path.join(dir, 's.json'), VENDO5_GPIO_BASE: path.join(dir, 'missing-gpio'),
      VENDO5_PORTAL_PORT: '3997', VENDO5_FIREWALL_CMD: 'noop', VENDO5_ARP_FAKE_MAC: 'm1' },
  });
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const res = await fetch('http://127.0.0.1:3997/api/status');
    assert.equal(res.status, 200);
  } finally { child.kill(); }
});

test('admin revoke, end to end: a paid session can be revoked via the real admin API, and the firewall/session file reflect it', async () => {
  const configDir = tmpDir();
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5sessfile-')), 'sessions.json');
  const gpioBase = fakeGpioBase();
  const mac = 'aa:bb:cc:dd:ee:ff';

  const r = run({
    VENDO5_CONFIG_DIR: configDir,
    VENDO5_DEFAULTS_DIR: DEFAULTS,
    VENDO5_SESSION_FILE: sessionFile,
    VENDO5_GPIO_BASE: gpioBase,
    VENDO5_PORTAL_PORT: '0',
    VENDO5_FIREWALL_CMD: 'noop',
    VENDO5_ARP_FAKE_MAC: mac,
  });
  await new Promise((res) => r.p.stdout.once('data', res));
  await waitFor(r, /portal listening/);
  const portLine = /"port":(\d+)/.exec(r.out());
  const port = Number(portLine[1]);

  try {
    // Pay a coin so there's a real active session to revoke.
    await new Promise((resolve, reject) => {
      const req = http.request({ port, method: 'POST', path: '/api/pay-intent' }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end();
    });
    const pinDir = path.join(gpioBase, 'gpio17');
    fs.writeFileSync(path.join(pinDir, 'value'), '1');
    await waitFor(r, /firewall allow/);

    // Log in as admin to get a real session cookie.
    const loginRes = await new Promise((resolve, reject) => {
      const req = http.request({ port, method: 'POST', path: '/admin/login', headers: { 'Content-Type': 'application/json' } }, (resp) => {
        let body = '';
        resp.on('data', (c) => { body += c; });
        resp.on('end', () => resolve({ body, headers: resp.headers }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ username: 'admin', password: 'admin' }));
    });
    assert.deepEqual(JSON.parse(loginRes.body), { ok: true });
    const cookie = loginRes.headers['set-cookie'][0].split(';')[0];

    // Revoke it through the real admin API.
    const revokeRes = await new Promise((resolve, reject) => {
      const req = http.request({ port, method: 'POST', path: `/admin/api/sessions/${mac}/revoke`, headers: { Cookie: cookie } }, (resp) => {
        let body = '';
        resp.on('data', (c) => { body += c; });
        resp.on('end', () => resolve({ status: resp.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(revokeRes.status, 200);
    assert.deepEqual(JSON.parse(revokeRes.body), { ok: true });

    await waitFor(r, /"message":"admin revoke"/);
    r.p.kill('SIGTERM');
    await r.exited;

    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(saved[mac], undefined); // revoked session is gone from the persisted file
  } finally {
    // ruling: `r.exited` is a Promise (always truthy), so `!r.exited` never
    // fired here; kill unconditionally -- killing an already-exited child is
    // a documented no-op in Node, safe on both the pass and fail path.
    r.p.kill('SIGTERM');
  }
});
