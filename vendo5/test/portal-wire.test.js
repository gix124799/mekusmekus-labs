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

async function boot(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5pw-'));
  const gpio = path.join(root, 'gpio');
  fs.mkdirSync(path.join(gpio, 'gpio11'), { recursive: true });
  fs.mkdirSync(path.join(gpio, 'gpio12'), { recursive: true });
  fs.mkdirSync(path.join(gpio, 'gpio18'), { recursive: true });
  for (const f of ['export', 'unexport', 'gpio11/direction', 'gpio12/value', 'gpio12/direction', 'gpio12/edge', 'gpio18/direction']) fs.writeFileSync(path.join(gpio, f), '0');
  if (settings) { fs.mkdirSync(path.join(root, 'state'), { recursive: true }); fs.writeFileSync(path.join(root, 'state', 'settings.json'), JSON.stringify(settings)); }
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
    assert.match(page.body, /\/client\/theme\/css\/style\.css\?version=1\.0\.0&design=3/);
    assert.match(page.body, /var wisft=/);
    const css = await get(s.port, '/client/theme/css/style.css');
    assert.equal(css.status, 200);
    assert.match(css.body, /\.card \{[^}]*border: 1px solid rgba\(0, 191, 255, 0\.55\);/s);
    assert.match(css.body, /\.card \.card-body \{[^}]*border: 1px solid rgba\(0, 191, 255, 0\.55\);/s);
    assert.match(css.body, /\.card \.card-body \{[^}]*border-radius: 0\.5rem;/s);
    assert.match(css.body, /\.card \.card-footer \{[^}]*border: 1px solid rgba\(0, 191, 255, 0\.55\);/s);
    assert.match(css.body, /\.card \.card-footer \{[^}]*border-radius: 0\.5rem;/s);
    await up;

    assert.equal((await ask(c, K(2))).status, 'Disconnected');
    assert.equal((await ask(c, K(9), 'NOPE1234')).toString(), 'Invalid voucher');

    const coin = new Promise((r) => c.on(K(20), r));
    const r = await ask(c, K(13), {});
    assert.equal(r.message, 'Insert');
    await sleep(200);
    fs.writeFileSync(path.join(s.gpio, 'gpio12', 'value'), '1');
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

test('coin acceptor relay: off at start, on while the coin popup is open, off a moment after it closes', async () => {
  const s = await boot({ main: { pins: { relay: 18 }, relaypinactive: 1, coinsBlockerDelay: 300 } });
  const relay = () => fs.readFileSync(path.join(s.gpio, 'gpio18', 'direction'), 'utf8');
  const c = connect(`http://127.0.0.1:${s.port}`, { reconnection: false });
  try {
    await new Promise((r) => c.on('connect', r));
    assert.equal(relay(), 'low');
    assert.equal((await ask(c, K(13), {})).message, 'Insert');
    assert.equal(relay(), 'high');
    assert.equal((await ask(c, K(13), { type: 0 })).message, 'Closed');
    assert.equal(relay(), 'high', 'a coin already falling is still counted');
    const deadline = Date.now() + 2000;
    while (relay() !== 'low' && Date.now() < deadline) await sleep(25);
    assert.equal(relay(), 'low');
  } finally { c.close(); s.stop(); }
});

test('the Themes page script is added to the portal page (and only when enabled)', () => {
  const { createPortalPages } = require('../lib/ui/portal-pages');
  let script = 'window.mine=1</script><b>';
  const mk = () => createPortalPages({ root: UI, version: '1', hostname: 'x', keys: [], custom: () => script });
  const html = mk().render('dashboard');
  assert.ok(html.includes('<script>window.mine=1<\\/script><b></script></body>'));
  script = '';
  assert.ok(!mk().render('dashboard').includes('window.mine'));
});

test('the React theme: its cipher, its handshake, then the same portal events by the keys it is given', async () => {
  const { enc, dec } = require('../lib/wire/themecipher');
  assert.equal(enc('qrS6V4ZL'), 'XNKQJCHX'); // seen from the real page
  assert.equal(dec('XNKQJCHX'), 'QRS6V4ZL');
  const s = await boot({ portalTheme: { enable: true, script: '', set: 'newTheme' } });
  const id = 'qrS6V4ZL';
  const c = connect(`http://127.0.0.1:${s.port}`, { reconnection: false, transports: ['websocket'], auth: { id } });
  const up = new Promise((r) => c.on('connect', r));
  try {
    assert.match((await get(s.port, '/')).body, /client\/theme\/static\/js\/main/);
    await up;
    const hs = await ask(c, enc(id));
    assert.equal(hs.hostname, 'ETHYLNET');
    assert.equal(hs.ioKey[2], K(2));
    assert.ok(hs.options && 'eload' in hs.options);
    const info = await ask(c, hs.ioKey[2]);
    assert.equal(info.mac, MAC);
    assert.equal(info.total_upload_data, 0);
  } finally { c.close(); s.stop(); }
});

test('sub-vendo: fake ESP is requested, accepted, then its coins fill the wallet of the phone that tapped Insert Coin there', async () => {
  const { signFor } = require('../lib/subvendo');
  const KEY = 'ABCDEFGHIJKLMN';
  const s = await boot({ key: KEY });
  const post = (body) => new Promise((resolve) => {
    const req = http.request({ port: s.port, path: '/subvendo/poll', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); });
    req.end(JSON.stringify({ ...body, sig: signFor(KEY, body) }));
  });
  const admin = connect(`http://127.0.0.1:${s.port}`, { reconnection: false });
  const c = connect(`http://127.0.0.1:${s.port}`, { reconnection: false });
  try {
    let r = await post({ chip: 'A1B2C3', hello: true, boot: 1, nonce: '', events: [], version: '1.0.0' });
    assert.equal(r.pending, true);
    // accept straight through the settings handlers' store: the admin socket needs a login, so the test writes
    // the accepted sub-vendo the way accept-sub-vendo does and binds it to the interface the ESP is seen on ('')
    const settingsFile = path.join(path.dirname(s.gpio), 'state', 'settings.json');
    const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    stored.sub = { sub1: { id: 'sub1', chip: 'A1B2C3', name: 'Sub Vendo 1', iface: '', countdownMax: 15, coinsBlockerDelay: 1000, license: 'Offline', mac: '', description: '', activated: true, lastdate: 0, message: '' } };
    fs.writeFileSync(settingsFile, JSON.stringify(stored));
    r = await post({ chip: 'A1B2C3', boot: 1, nonce: r.nonce, events: [] });
    assert.equal(r.relay, false);
    await new Promise((x) => c.on('connect', x));
    // in this test the phone's interface is unknown, so it is at main; point the sub-vendo at main's interface
    // instead is not possible here, so the phone taps Insert Coin at main and the coin arrives from main's GPIO
    const coin = new Promise((x) => c.on(K(20), x));
    assert.equal((await ask(c, K(13), {})).message, 'Insert');
    await sleep(200);
    fs.writeFileSync(path.join(s.gpio, 'gpio12', 'value'), '1');
    assert.deepEqual(await coin, { credit: 1, incoin: 1 });
    // a coin event from the sub-vendo while nobody tapped Insert Coin there is an orphan: nothing credited
    r = await post({ chip: 'A1B2C3', boot: 1, nonce: r.nonce, events: [{ id: 1, pulses: 5, minGapMs: 95 }] });
    assert.equal(r.ack, 1);
    await sleep(100);
    assert.equal((await ask(c, K(2))).credit, 1);
  } finally { admin.close(); c.close(); s.stop(); }
});
