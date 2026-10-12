const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { createPages } = require('../lib/ui/pages');
const { createStatic } = require('../lib/ui/static');
const { createSessions } = require('../lib/wire/session');
const { createAdminRoutes } = require('../lib/ui/admin-routes');

const ROOT = require('./helpers/ui-root');

async function rig() {
  const sessions = createSessions();
  const pages = createPages({ root: ROOT, version: '1.2.3', hostname: 'vendo' });
  const handle = createAdminRoutes({ pages, sessions, serveStatic: createStatic({ root: ROOT }) });
  const server = http.createServer((req, res) => { if (!handle(req, res)) res.writeHead(200, { 'Content-Type': 'text/plain' }).end('FALLTHROUGH'); });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const call = (method, p, { cookie, body, type } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = type || 'application/json';
    const req = http.request({ port, method, path: p, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { sessions, call, stop: () => server.close() };
}
const loggedIn = (r) => { const s = r.sessions.create(); r.sessions.allow(s); return `vendo5_sid=${s.id}`; };

test('GET /admin without a cookie: the login page and a hardened session cookie', async () => {
  const r = await rig();
  try {
    const res = await r.call('GET', '/admin');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /<h3[^>]*>MEKUSMEKUS<\/h3>/);
    const ck = res.headers['set-cookie'][0];
    for (const part of ['vendo5_sid=', 'HttpOnly', 'SameSite=Strict', 'Path=/admin', 'Max-Age=3600']) assert.ok(ck.includes(part), part + ' in ' + ck);
    assert.equal(r.sessions.size(), 1);
  } finally { r.stop(); }
});

test('GET /admin with an existing logged-out session reuses it (no new cookie, no new session)', async () => {
  const r = await rig();
  try {
    const s = r.sessions.create();
    const res = await r.call('GET', '/admin?page=dashboard', { cookie: `vendo5_sid=${s.id}` });
    assert.match(res.body, /<h3[^>]*>MEKUSMEKUS<\/h3>/, 'logged out: the page param is ignored');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(r.sessions.size(), 1);
  } finally { r.stop(); }
});

test('logged in: the shell for an enabled page, a redirect for a missing or disabled one', async () => {
  const r = await rig();
  try {
    const cookie = loggedIn(r);
    const shell = await r.call('GET', '/admin?page=logs', { cookie });
    assert.equal(shell.status, 200);
    assert.ok(shell.body.includes('/nav/script/logs.js?version=1.2.3'));
    for (const url of ['/admin', '/admin?page=nonexistent', '/admin?page=', '/admin?page=../../etc', '/admin?page=<script>', '/admin?page=dashboard%00']) {
      const res = await r.call('GET', url, { cookie });
      assert.equal(res.status, 302, url);
      assert.equal(res.headers.location, '/admin?page=dashboard', url);
    }
    assert.equal((await r.call('GET', '/admin?page=dashboard', { cookie })).status, 200);
  } finally { r.stop(); }
});

test('POST /admin from the login form: redirect to the dashboard only when logged in', async () => {
  const r = await rig();
  try {
    const out = await r.call('POST', '/admin', { body: '', type: 'application/x-www-form-urlencoded' });
    assert.equal(out.status, 302);
    assert.equal(out.headers.location, '/admin');
    const notYet = r.sessions.create();
    assert.equal((await r.call('POST', '/admin', { cookie: `vendo5_sid=${notYet.id}`, body: 'x=1', type: 'application/x-www-form-urlencoded' })).headers.location, '/admin');
    const res = await r.call('POST', '/admin', { cookie: loggedIn(r), body: '', type: 'application/x-www-form-urlencoded' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin?page=dashboard');
  } finally { r.stop(); }
});

test('POST /admin {logout:true} ends the session and clears the cookie; the next GET is the login page', async () => {
  const r = await rig();
  try {
    const cookie = loggedIn(r);
    const res = await r.call('POST', '/admin?', { cookie, body: JSON.stringify({ logout: true }) });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{}');
    assert.match(res.headers['set-cookie'][0], /Max-Age=0/);
    assert.match((await r.call('GET', '/admin?page=dashboard', { cookie })).body, /<h3[^>]*>MEKUSMEKUS<\/h3>/);
  } finally { r.stop(); }
});

test('POST /admin tolerates junk and oversized bodies', async () => {
  const r = await rig();
  try {
    for (const body of ['{{{{', 'null', '[1]', '"x"', 'x'.repeat(100000)]) {
      const res = await r.call('POST', '/admin', { body });
      assert.equal(res.status, 302, body.slice(0, 10));
    }
    assert.equal((await r.call('GET', '/admin')).status, 200);
  } finally { r.stop(); }
});

test('static assets are served through the same handler; raw html and other methods fall through', async () => {
  const r = await rig();
  try {
    const js = await r.call('GET', '/nav/script/dashboard.js?version=1');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.equal((await r.call('GET', '/socket.io.js?version=1')).status, 200);
    assert.equal((await r.call('GET', '/nav/index.html')).body, 'FALLTHROUGH');
    assert.equal((await r.call('PUT', '/admin', { body: '{}' })).body, 'FALLTHROUGH');
    assert.equal((await r.call('DELETE', '/admin')).body, 'FALLTHROUGH');
  } finally { r.stop(); }
});

test('a logged-in admin gets the ticket print view for ?page=ticket; a visitor gets the login page', async () => {
  const r = await rig();
  try {
    const anon = await r.call('GET', '/admin?page=ticket&file=voucher-1');
    assert.ok(/login-btn/.test(anon.body));
    const t = await r.call('GET', '/admin?page=ticket&file=voucher-1', { cookie: loggedIn(r) });
    assert.equal(t.status, 200);
    assert.ok(t.body.includes('script/ticket.js'));
    assert.ok(t.body.includes('barcode.js'));
  } finally { r.stop(); }
});
