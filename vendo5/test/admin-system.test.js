const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createPages } = require('../lib/ui/pages');
const { createStatic } = require('../lib/ui/static');
const { createSessions } = require('../lib/wire/session');
const { createAdminRoutes } = require('../lib/ui/admin-routes');
const { createSystemHandlers } = require('../lib/wire/system');
const { exportConfig, FORMAT } = require('../lib/system/sysconfig');

const ROOT = require('./helpers/ui-root');
const BOUNDARY = '----b0undary';
const multipart = (buf) => Buffer.concat([Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\n`), buf, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]);

async function rig({ updateEnabled = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5st-'));
  fs.writeFileSync(path.join(stateDir, 'settings.json'), '{"a":1}');
  const sessions = createSessions();
  const lines = [];
  let restarts = 0;
  const system = { stateDir, version: '9.9.9', restart: () => { restarts++; }, mainlog: { write: (c, t) => lines.push(t) }, appDir: path.join(stateDir, 'app'), runCommand: () => '', updateEnabled };
  const handle = createAdminRoutes({ pages: createPages({ root: ROOT, version: '1', hostname: 'h' }), sessions, serveStatic: createStatic({ root: ROOT }), system });
  const server = http.createServer((req, res) => { if (!handle(req, res)) res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const call = (method, p, { cookie, body, type } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (type) headers['Content-Type'] = type;
    const q = http.request({ port, method, path: p, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
    q.on('error', reject);
    q.end(body);
  });
  const login = () => { const s = sessions.create(); sessions.allow(s); return `vendo5_sid=${s.id}`; };
  return { call, login, stateDir, lines, restarts: () => restarts, stop: () => server.close() };
}

test('export: a logged-in admin downloads a backup; a visitor gets the login page, not data', async () => {
  const r = await rig();
  try {
    const anon = await r.call('GET', '/admin?export=sysconfig');
    assert.ok(/login-btn/.test(anon.body.toString()));
    const res = await r.call('GET', '/admin?export=sysconfig', { cookie: r.login() });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'], /attachment; filename="vendo5-backup.json"/);
    assert.equal(JSON.parse(res.body).format, FORMAT);
    assert.ok(r.lines.some((l) => /downloaded a backup/.test(l)));
  } finally { r.stop(); }
});

test('import: a good backup restores and restarts; a bad file, a missing file and a visitor are refused', async () => {
  const r = await rig();
  try {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'v5src-'));
    fs.writeFileSync(path.join(other, 'settings.json'), '{"restored":true}');
    const good = multipart(exportConfig(other, '1'));
    const type = `multipart/form-data; boundary=${BOUNDARY}`;
    const anon = await r.call('POST', '/admin?import=sysconfig', { body: good, type });
    assert.equal(anon.status, 401);
    assert.equal(fs.readFileSync(path.join(r.stateDir, 'settings.json'), 'utf8'), '{"a":1}');
    const ok = await r.call('POST', '/admin?import=sysconfig', { cookie: r.login(), body: good, type });
    assert.equal(ok.body.toString(), 'DONE');
    assert.equal(fs.readFileSync(path.join(r.stateDir, 'settings.json'), 'utf8'), '{"restored":true}');
    assert.equal(r.restarts(), 1);
    const bad = await r.call('POST', '/admin?import=sysconfig', { cookie: r.login(), body: multipart(Buffer.from('hello')), type });
    assert.equal(bad.body.toString(), 'Error');
    const nofile = await r.call('POST', '/admin?import=sysconfig', { cookie: r.login(), body: Buffer.from('plain'), type: 'text/plain' });
    assert.equal(nofile.status, 400);
    assert.equal(r.restarts(), 1, 'a refused upload never restarts');
  } finally { r.stop(); }
});

test('software upload is refused off the device (updates replace the running directory)', async () => {
  const r = await rig({ updateEnabled: false });
  try {
    const res = await r.call('POST', '/admin?import=wifi-soft', { cookie: r.login(), body: multipart(Buffer.from('x')), type: `multipart/form-data; boundary=${BOUNDARY}` });
    assert.equal(res.body.toString(), 'Error');
    assert.equal(r.restarts(), 0);
  } finally { r.stop(); }
});

function sysRig(over = {}) {
  const said = [];
  const lines = [];
  let restarts = 0;
  const h = createSystemHandlers({ appDir: '/x/app', runCommand: () => '', mainlog: { write: (c, t) => lines.push(t) }, restart: () => { restarts++; }, enabled: true, tmpDir: os.tmpdir(), ...over });
  const ctx = { socket: { emit: (e, t) => said.push([e, t]) } };
  return { run: (payload) => h['@SYSTEM-30025'].handler(payload, ctx), said: () => said.map((s) => s[1]), events: () => [...new Set(said.map((s) => s[0]))], lines, restarts: () => restarts, h };
}

test('system update by link: download, install, restart, progress lines ending in Done', async () => {
  const r = sysRig({ fetch: async (url, dest, o) => { o.onProgress(50); fs.writeFileSync(dest, 'x'); return { ok: true }; }, apply: () => ({ ok: true, version: '2.0.0' }) });
  await r.run({ url: 'http://10.0.0.5/u.tar.gz' });
  assert.deepEqual(r.events(), ['@SYSTEM-909947']);
  assert.deepEqual(r.said().slice(-4), ['50%', 'Checking and installing', 'Installed version 2.0.0. Restarting.', 'Done']);
  assert.equal(r.restarts(), 1);
  assert.match(r.lines[0], /installed the update 2.0.0/);
});

test('system update failures say why, never restart, and always finish with Done', async () => {
  const dl = sysRig({ fetch: async () => ({ ok: false, error: 'The server answered 404' }) });
  await dl.run({ url: 'http://x/u' });
  assert.ok(dl.said().includes('Error: The server answered 404'));
  assert.equal(dl.said().at(-1), 'Done');
  const ap = sysRig({ fetch: async (u, d) => { fs.writeFileSync(d, 'x'); return { ok: true }; }, apply: () => ({ ok: false, error: 'This is not a vendo5 update' }) });
  await ap.run({ url: 'http://x/u' });
  assert.ok(ap.said().includes('Error: This is not a vendo5 update'));
  assert.equal(ap.restarts() + dl.restarts(), 0);
  const off = sysRig({ enabled: false });
  await off.run({ url: 'http://x/u' });
  assert.match(off.said()[0], /only available on the device/);
  const junk = sysRig();
  await junk.run(null);
  assert.equal(junk.said().at(-1), 'Done');
});

test('only one update runs at a time, and the temp file is always removed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const files = [];
  const r = sysRig({ fetch: async (u, d) => { files.push(d); fs.writeFileSync(d, 'x'); await gate; return { ok: false, error: 'stop' }; } });
  const first = r.run({ url: 'http://x/a' });
  await new Promise((x) => setTimeout(x, 20));
  await r.run({ url: 'http://x/b' });
  assert.ok(r.said().includes('An update is already running.'));
  release();
  await first;
  assert.equal(fs.existsSync(files[0]), false);
});
