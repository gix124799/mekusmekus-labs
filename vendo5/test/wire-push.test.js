const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const { createSessions } = require('../lib/wire/session');
const { attachWire } = require('../lib/wire/server');

test('pushAuthed reaches sockets whose session is logged in, and never a login-page socket or an expired session', async () => {
  const sessions = createSessions();
  const server = http.createServer((q, s) => s.end());
  const io = attachWire(server, { events: {}, sessions });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const open = (cookie) => new Promise((resolve, reject) => {
    const c = connect(`http://127.0.0.1:${port}`, { path: '/admin', reconnection: false, extraHeaders: { cookie }, transports: ['websocket'] });
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
  const inn = sessions.create(); sessions.allow(inn);
  const visitor = sessions.create();
  const gone = sessions.create(); sessions.allow(gone);
  const a = await open(`vendo5_sid=${inn.id}`);
  const b = await open(`vendo5_sid=${visitor.id}`);
  const c = await open(`vendo5_sid=${gone.id}`);
  const got = { a: [], b: [], c: [] };
  a.on('@x', (p) => got.a.push(p)); b.on('@x', (p) => got.b.push(p)); c.on('@x', (p) => got.c.push(p));
  sessions.destroy(gone.id);
  io.pushAuthed('@x', { n: 1 });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(got, { a: [{ n: 1 }], b: [], c: [] });
  for (const s of [a, b, c]) s.close();
  io.close();
  server.close();
});
