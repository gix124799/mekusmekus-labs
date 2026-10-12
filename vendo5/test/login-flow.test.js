// The whole login the way a browser does it, against the real pages, routes, sessions and handlers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { io: connect } = require('socket.io-client');
const { createPages } = require('../lib/ui/pages');
const { createStatic } = require('../lib/ui/static');
const { createSessions } = require('../lib/wire/session');
const { createAdminRoutes } = require('../lib/ui/admin-routes');
const { attachWire } = require('../lib/wire/server');
const { createMainHandlers } = require('../lib/wire/main');

const ROOT = require('./helpers/ui-root');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'main', 'js', 'md5.js'), 'utf8'), sandbox);

async function rig(password = 'secret99') {
  const sessions = createSessions();
  const pages = createPages({ root: ROOT, version: '1.2.3', hostname: 'vendo' });
  const handle = createAdminRoutes({ pages, sessions, serveStatic: createStatic({ root: ROOT }) });
  const server = http.createServer((req, res) => { if (!handle(req, res)) res.writeHead(404).end(); });
  const account = { get: () => ({ username: 'admin', password }), change: () => false };
  const events = createMainHandlers({ account, sessions, licence: { deviceId: () => 'abcdef0123456789' }, version: '1.2.3' });
  const io = attachWire(server, { events, sessions });
  await new Promise((r) => server.listen(0, r));
  return { sessions, port: server.address().port, stop: () => { io.close(); server.close(); } };
}
const req = (port, method, p, { cookie, body, type } = {}) => new Promise((resolve, reject) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = type;
  const q = http.request({ port, method, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  q.on('error', reject);
  q.end(body);
});
const open = (port, cookie) => new Promise((resolve, reject) => {
  const c = connect('http://127.0.0.1:' + port, { path: '/admin', reconnection: false, transports: ['websocket', 'polling'], extraHeaders: { cookie } });
  c.on('connect', () => resolve(c));
  c.on('connect_error', reject);
});
const ask = (c, id, payload) => new Promise((resolve) => (payload === undefined ? c.emit(id, resolve) : c.emit(id, payload, resolve)));

async function browserLogin(port, user, pass) {
  const page = await req(port, 'GET', '/admin');
  const cookie = page.headers['set-cookie'][0].split(';')[0];
  const sock = await open(port, cookie);
  const token = await ask(sock, '@main-48931'); // the page sends an emit with only a callback
  const answer = {
    uname: user,
    username: sandbox.hexMD5(token.substring(0, (token.length - 1) / 2) + user.toLowerCase().replace(/\s/g, '')),
    password: sandbox.hexMD5(token.substring((token.length - 1) / 2, token.length) + pass.replace(/\s/g, '')),
  };
  const reply = await ask(sock, '@main-66589', answer);
  sock.close();
  return { cookie, reply };
}

test('full browser login: login page, socket challenge, form post, shell', async () => {
  const r = await rig();
  try {
    const { cookie, reply } = await browserLogin(r.port, 'Admin', 'secret99');
    assert.deepEqual(reply, { login: true });
    const submit = await req(r.port, 'POST', '/admin', { cookie, body: '', type: 'application/x-www-form-urlencoded' });
    assert.equal(submit.status, 302);
    assert.equal(submit.headers.location, '/admin?page=dashboard');
    const shell = await req(r.port, 'GET', '/admin?page=dashboard', { cookie });
    assert.equal(shell.status, 200);
    assert.ok(shell.body.includes('/nav/script/dashboard.js?version=1.2.3'));
  } finally { r.stop(); }
});

test('wrong password: the form post bounces back to the login page and no shell is served', async () => {
  const r = await rig();
  try {
    const { cookie, reply } = await browserLogin(r.port, 'admin', 'wrong');
    assert.deepEqual(reply, { login: false });
    assert.equal((await req(r.port, 'POST', '/admin', { cookie, body: '', type: 'application/x-www-form-urlencoded' })).headers.location, '/admin');
    assert.match((await req(r.port, 'GET', '/admin?page=dashboard', { cookie })).body, /<h3[^>]*>MEKUSMEKUS<\/h3>/);
  } finally { r.stop(); }
});

test('the login page form can no longer post a plaintext password', async () => {
  const r = await rig();
  try {
    const page = (await req(r.port, 'GET', '/admin')).body;
    assert.ok(!/name="admin-(username|password)"/.test(page));
  } finally { r.stop(); }
});

test('a socket that connects without the page cookie cannot log in a browser that has one', async () => {
  const r = await rig();
  try {
    const page = await req(r.port, 'GET', '/admin');
    const cookie = page.headers['set-cookie'][0].split(';')[0];
    const stranger = await open(r.port, 'vendo5_sid=forged');
    assert.equal(await ask(stranger, '@main-48931'), '', 'no session, no token');
    stranger.close();
    assert.match((await req(r.port, 'GET', '/admin?page=dashboard', { cookie })).body, /<h3[^>]*>MEKUSMEKUS<\/h3>/);
  } finally { r.stop(); }
});

test('logout from the shell ends the session', async () => {
  const r = await rig();
  try {
    const { cookie } = await browserLogin(r.port, 'admin', 'secret99');
    assert.equal((await req(r.port, 'GET', '/admin?page=dashboard', { cookie })).status, 200);
    assert.equal((await req(r.port, 'POST', '/admin?', { cookie, body: '{"logout":true}', type: 'application/json' })).status, 200);
    assert.match((await req(r.port, 'GET', '/admin?page=dashboard', { cookie })).body, /<h3[^>]*>MEKUSMEKUS<\/h3>/);
  } finally { r.stop(); }
});
