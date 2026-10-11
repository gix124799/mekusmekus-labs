// The customer portal over its socket, against the real main.js: the page, the coin popup filling the wallet, Connect.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io: connect } = require('socket.io-client');

const MAIN = path.join(__dirname, '..', 'main.js');
const UI = require('./helpers/ui-root');
const MAC = 'aa:bb:cc:dd:ee:99';
const K = (n) => `@portal-${n}`;
const ask = (c, id, payload) => new Promise((resolve) => c.emit(id, payload, resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5pw-'));
  const gpio = path.join(root, 'gpio');
  fs.mkdirSync(path.join(gpio, 'gpio17'), { recursive: true });
  for (const f of ['export', 'unexport', 'gpio17/value', 'gpio17/direction', 'gpio17/edge']) fs.writeFileSync(path.join(gpio, f), '0');
  const p = spawn(process.execPath, [MAIN], { env: { ...process.env, VENDO5_CONFIG_DIR: path.join(root, 'cfg'), VENDO5_DEFAULTS_DIR: path.join(__dirname, '..', 'config'), VENDO5_SESSION_FILE: path.join(root, 's.json'), VENDO5_STATE_DIR: path.join(root, 'state'), VENDO5_UI_DIR: UI, VENDO5_GPIO_BASE: gpio, VENDO5_PORTAL_PORT: '0', VENDO5_FIREWALL_CMD: 'noop', VENDO5_ARP_FAKE_MAC: MAC } });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  for (let i = 0; i < 160 && !/portal listening/.test(out); i++) await sleep(50);
  const line = /^.*"portal listening".*$/m.exec(out);
  if (!line) { p.kill('SIGKILL'); throw new Error(out); }
  return { port: JSON.parse(line[0]).port, gpio, stop: () => p.kill('SIGKILL') };
}

const get = (port, p) => new Promise((resolve) => http.get({ port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }));

test('portal page, theme files, coins into the wallet, then Connect', async () => {
  const s = await boot();
  const c = connect(`http://127.0.0.1:${s.port}`, { reconnection: false });
  const up = new Promise((r) => c.on('connect', r));
  try {
    const page = await get(s.port, '/?page=dashboard');
    assert.match(page.body, /client\/script\/dashboard\.js/);
    assert.match(page.body, /var wisft=/);
    assert.equal((await get(s.port, '/client/theme/css/style.css')).status, 200);
    await up;

    assert.equal((await ask(c, K(2))).status, 'Disconnected');
    assert.equal((await ask(c, K(9), 'NOPE1234')).toString(), 'Invalid voucher');

    const coin = new Promise((r) => c.on(K(20), r));
    const r = await ask(c, K(13), {});
    assert.equal(r.message, 'Insert');
    await sleep(200);
    fs.writeFileSync(path.join(s.gpio, 'gpio17', 'value'), '1');
    assert.deepEqual(await coin, { credit: 1, incoin: 1 });

    assert.equal((await ask(c, K(2))).credit, 1);
    assert.equal(await ask(c, K(11), 5), 'Insufficient Credit');
    assert.equal(await ask(c, K(11), 1), 'Success');
    const info = await ask(c, K(2));
    assert.equal(info.status, 'Connected');
    assert.equal(info.credit, 0);
    assert.ok(info.duration > 0);
    assert.equal(await ask(c, K(4)), 'Disconnected');
    assert.equal((await ask(c, K(2))).status, 'Disconnected');
    assert.equal(await ask(c, K(5)), 'Connected');
  } finally { c.close(); s.stop(); }
});
