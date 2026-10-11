const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const { createSessions } = require('../lib/wire/session');
const { attachWire } = require('../lib/wire/server');

async function rig(events, { now } = {}) {
  const clock = { t: 1000000 };
  const sessions = createSessions({ now: now || (() => clock.t) });
  const logs = [];
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('PAGE ' + req.url); });
  const io = attachWire(server, { events, sessions, log: (...a) => logs.push(a) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const open = (cookie, extra = {}) => new Promise((resolve, reject) => {
    const c = connect('http://127.0.0.1:' + port, { path: '/admin', reconnection: false, transports: ['websocket'], extraHeaders: cookie ? { cookie: `vendo5_sid=${cookie}` } : {}, ...extra });
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
  const get = (p) => new Promise((resolve) => http.get({ port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, loc: r.headers.location, body: b })); }));
  const stop = () => { io.close(); server.close(); };
  return { sessions, logs, open, get, stop, clock, port };
}
const ask = (c, id, payload) => new Promise((resolve) => c.emit(id, payload, resolve));
const disconnected = (c) => new Promise((resolve) => (c.connected ? c.once('disconnect', resolve) : resolve()));

test('page routes are untouched; a bare /admin/ goes to the dashboard like the original nginx did', async () => {
  const r = await rig({});
  try {
    assert.equal((await r.get('/admin')).body, 'PAGE /admin');
    assert.equal((await r.get('/admin?page=logs')).body, 'PAGE /admin?page=logs');
    const bare = await r.get('/admin/');
    assert.equal(bare.status, 302);
    assert.equal(bare.loc, '/admin?page=dashboard');
    assert.equal((await r.get('/admin/?x=1')).status, 302);
    assert.equal((await r.get('/theme/a.css')).body, 'PAGE /theme/a.css');
  } finally { r.stop(); }
});

test('an unguarded event works without a session; the reply comes back through the ack', async () => {
  const r = await rig({ '@t-open': { guard: false, fallback: 'F', handler: (p, ctx) => ({ echo: p, hasSession: !!ctx.session }) } });
  try {
    const c = await r.open('');
    assert.deepEqual(await ask(c, '@t-open', { a: 1 }), { echo: { a: 1 }, hasSession: false });
    c.close();
  } finally { r.stop(); }
});

test('a guarded event is refused without a login: the socket is disconnected and the handler never runs', async () => {
  let ran = 0;
  const r = await rig({ '@t-guard': { guard: true, fallback: 'F', handler: () => { ran++; return 'ok'; } } });
  try {
    for (const cookie of ['', 'forged', r.sessions.create().id]) { // no cookie, unknown cookie, a real but not-logged-in session
      const c = await r.open(cookie);
      const gone = disconnected(c);
      c.emit('@t-guard', {}, () => { ran++; });
      await gone;
    }
    assert.equal(ran, 0);
  } finally { r.stop(); }
});

test('a logged-in session runs guarded events, and sees its own session and the client ip', async () => {
  const r = await rig({ '@t-guard': { guard: true, fallback: 'F', handler: (p, ctx) => ({ sid: ctx.session.id, ip: ctx.ip }) } });
  try {
    const s = r.sessions.create();
    r.sessions.allow(s);
    const c = await r.open(s.id, { extraHeaders: { cookie: `vendo5_sid=${s.id}`, 'x-forwarded-for': '10.0.0.9, 192.168.1.1' } });
    assert.deepEqual(await ask(c, '@t-guard', {}), { sid: s.id, ip: '10.0.0.9' });
    c.close();
  } finally { r.stop(); }
});

test('the session expiring while connected takes effect on the very next event', async () => {
  const r = await rig({ '@t-guard': { guard: true, fallback: 'F', handler: () => 'ok' } });
  try {
    const s = r.sessions.create();
    r.sessions.allow(s);
    const c = await r.open(s.id);
    assert.equal(await ask(c, '@t-guard', {}), 'ok');
    r.clock.t += 3600001;
    const gone = disconnected(c);
    c.emit('@t-guard', {}, () => {});
    await gone;
  } finally { r.stop(); }
});

test('a handler that throws is logged and the client gets the fallback, not an exception', async () => {
  const r = await rig({
    '@t-boom': { guard: false, fallback: { err: 'x' }, handler: () => { throw new Error('boom'); } },
    '@t-reject': { guard: false, fallback: 'rejected', handler: async () => { throw new Error('async boom'); } },
  });
  try {
    const c = await r.open('');
    assert.deepEqual(await ask(c, '@t-boom', {}), { err: 'x' });
    assert.equal(await ask(c, '@t-reject', {}), 'rejected');
    assert.deepEqual(r.logs.map((l) => [l[0], l[1], l[2].error]), [['error', 'wire handler @t-boom failed', 'boom'], ['error', 'wire handler @t-reject failed', 'async boom']]);
    assert.equal(c.connected, true, 'the socket survives');
    c.close();
  } finally { r.stop(); }
});

test('async handlers are awaited; a payload-less emit with only a callback passes undefined', async () => {
  const r = await rig({ '@t-async': { guard: false, fallback: 'F', handler: async (p) => { await new Promise((x) => setTimeout(x, 20)); return typeof p; } } });
  try {
    const c = await r.open('');
    assert.equal(await new Promise((resolve) => c.emit('@t-async', resolve)), 'undefined');
    c.close();
  } finally { r.stop(); }
});

test('unknown events and events without a callback are harmless', async () => {
  let seen = 0;
  const r = await rig({ '@t-fire': { guard: false, fallback: 'F', handler: () => { seen++; return 1; } } });
  try {
    const c = await r.open('');
    c.emit('@nobody-handles-this', { x: 1 });
    c.emit('@t-fire', { x: 1 }); // no ack function
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(seen, 1);
    assert.equal(c.connected, true);
    c.close();
  } finally { r.stop(); }
});

test('polling transport works too (the original client lists websocket first, polling as fallback)', async () => {
  const r = await rig({ '@t-open': { guard: false, fallback: 'F', handler: () => 'ok' } });
  try {
    const c = await r.open('', { transports: ['polling'] });
    assert.equal(await ask(c, '@t-open', {}), 'ok');
    c.close();
  } finally { r.stop(); }
});
