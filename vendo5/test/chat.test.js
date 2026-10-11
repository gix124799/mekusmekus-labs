const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChat } = require('../lib/store/chat');
const { createChatHandlers, clientSend } = require('../lib/wire/chat');
const { createClients } = require('../lib/store/clients');

const M1 = 'aa:bb:cc:dd:ee:01';
const M2 = 'aa:bb:cc:dd:ee:02';
const EMOJI = '<svg viewBox="0 0 22 23" height="20" width="20"><path d="M1 1" fill="#0084ff"></path></svg>';

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5ch-'));
  let t = 1000;
  const chat = createChat({ dir: path.join(dir, 'chat'), now: () => t });
  const clients = createClients({ file: path.join(dir, 'c.json') });
  clients.setName(M1, 'Maria');
  clients.setName(M2, 'Pedro');
  const pushed = [];
  const push = (e, p) => pushed.push([e, p]);
  const lines = [];
  const h = createChatHandlers({ chat, clients, online: () => new Set([M1]), push, mainlog: { write: (c, x) => lines.push(x) } });
  return { chat, clients, h, pushed, lines, call: (id, p) => h[id].handler(p, {}), tick: (ms) => { t += ms; }, push };
}

test('every chat event is guarded', () => { for (const [id, d] of Object.entries(rig().h)) assert.equal(d.guard, true, id); });

test('messages: text is stored escaped, emoji must be a plain svg, junk and over-long input are refused or cut', () => {
  const r = rig();
  const a = r.chat.sendClient(M1, { type: 'text', message: '<img src=x onerror=alert(1)> hi & bye' });
  assert.equal(a.msg.message, '&lt;img src=x onerror=alert(1)&gt; hi &amp; bye');
  assert.equal(a.msg.sender, 'user');
  assert.ok(r.chat.sendAdmin(M1, { type: 'emoji', message: EMOJI }));
  for (const bad of [{ type: 'emoji', message: '<script>x</script>' }, { type: 'emoji', message: '<svg><script>x</script></svg>' }, { type: 'text', message: '   ' }, { type: 'html', message: 'x' }, { type: 'text', message: 5 }, null, 'x']) assert.equal(r.chat.sendAdmin(M1, bad), null, JSON.stringify(bad));
  assert.equal(r.chat.sendAdmin('nope', { type: 'text', message: 'x' }), null);
  assert.equal(Object.values(r.chat.history(M1)).length, 2);
  r.chat.sendAdmin(M2, { type: 'text', message: 'x'.repeat(5000) });
  assert.equal(Object.values(r.chat.history(M2))[0].message.length, 1000);
  assert.deepEqual(r.chat.history('../x'), {});
});

test('two messages in the same millisecond both survive; the log is capped at the newest 300', () => {
  const r = rig();
  r.chat.sendClient(M1, { type: 'text', message: 'a' });
  r.chat.sendClient(M1, { type: 'text', message: 'b' });
  assert.equal(Object.keys(r.chat.history(M1)).length, 2);
  for (let i = 0; i < 320; i++) { r.tick(1); r.chat.sendClient(M1, { type: 'text', message: `m${i}` }); }
  const h = Object.values(r.chat.history(M1));
  assert.equal(h.length, 300);
  assert.equal(h.at(-1).message, 'm319');
});

test('seen flags: a client message is unread for the admin until opened; an admin message unread for the client until fetched', () => {
  const r = rig();
  r.chat.sendClient(M1, { type: 'text', message: 'hello' });
  assert.deepEqual(r.chat.unread(), { [M1]: true });
  assert.deepEqual(r.call('@CHATAPP-65478'), { [M1]: true });
  assert.equal(r.call('@CHATAPP-659873', { mac: M1 }), true);
  assert.deepEqual(r.chat.unread(), {});
  assert.equal(r.pushed.at(-1)[0], '@CHATAPP-0001');
  r.chat.sendAdmin(M1, { type: 'text', message: 'hi' });
  assert.equal(r.chat.clientHasUnread(M1), true);
  r.chat.markClientSeen(M1);
  assert.equal(r.chat.clientHasUnread(M1), false);
  assert.equal(r.call('@CHATAPP-659873', { mac: 'zz' }), false);
});

test('admin list: only devices with a conversation, with name, online/offline, size and the new flag', () => {
  const r = rig();
  r.chat.sendClient(M1, { type: 'text', message: 'x' });
  r.chat.sendAdmin(M2, { type: 'text', message: 'y' });
  const l = r.call('@CHATAPP-22114');
  assert.deepEqual(Object.keys(l).sort(), [M1, M2]);
  assert.deepEqual([l[M1].name, l[M1].status, l[M1].adminseen, l[M2].status, l[M2].adminseen], ['Maria', 'online', false, 'offline', true]);
  assert.ok(l[M1].filesize.size > 0 && l[M1].filesize.mtimeMs > 0);
});

test('admin sends to one device or to all; the page is told; bad messages answer false', () => {
  const r = rig();
  assert.equal(r.call('@CHATAPP-96996', { mac: M1, smg: { type: 'text', message: 'hi' } }), true);
  assert.equal(r.call('@CHATAPP-96996', { mac: M1, smg: { type: 'text', message: '' } }), false);
  assert.equal(r.call('@CHATAPP-96996', { mac: 'bad', smg: { type: 'text', message: 'x' } }), false);
  assert.equal(r.call('@CHATAPP-96955', { smg: { type: 'text', message: 'all' } }), true);
  assert.equal(Object.values(r.chat.history(M2))[0].message, 'all');
  assert.ok(r.pushed.some(([e]) => e === '@CHATAPP-456321'));
  assert.match(r.lines.at(-1), /sent a message to 2 client/);
  assert.equal(r.call('@CHATAPP-96955', { smg: null }), false);
});

test('delete one conversation, and clear all', () => {
  const r = rig();
  r.chat.sendClient(M1, { type: 'text', message: 'x' });
  r.chat.sendClient(M2, { type: 'text', message: 'y' });
  assert.equal(r.call('@CHATAPP-234411', { mac: M1 }), true);
  assert.deepEqual(Object.keys(r.chat.list()), [M2]);
  assert.equal(r.call('@CHATAPP-234411', { mac: '../x' }), false);
  assert.equal(r.call('@nav-233202'), 'Success');
  assert.deepEqual(r.chat.list(), {});
});

test('auto-reply: validated settings; replies once per interval, only when enabled', () => {
  const r = rig();
  assert.deepEqual(r.call('@CHATAPP-89874GET'), { interval: 30, message: '', enable: false });
  assert.equal(r.call('@CHATAPP-89874SAVE', { interval: 10, message: 'Back soon <b>', enable: true }), true);
  assert.equal(r.call('@CHATAPP-89874GET').message, 'Back soon &lt;b&gt;');
  for (const bad of [{ interval: 0, message: 'x' }, { interval: 5000, message: 'x' }, { interval: 'a', message: 'x' }, { interval: 5, message: 5 }, null]) assert.equal(r.call('@CHATAPP-89874SAVE', bad), false, JSON.stringify(bad));
  const c2 = { chat: r.chat, push: r.push };
  r.tick(5000000);
  clientSend(c2, M1, 'anyone?');
  const adminMsgs = () => Object.values(r.chat.history(M1)).filter((m) => m.sender === 'admin');
  assert.equal(adminMsgs().length, 1);
  assert.equal(adminMsgs()[0].message, 'Back soon &lt;b&gt;');
  r.tick(60000);
  clientSend(c2, M1, 'hello?');
  assert.equal(adminMsgs().length, 1, 'not again within 10 minutes');
  r.tick(11 * 60000);
  clientSend(c2, M1, 'hello??');
  assert.equal(adminMsgs().length, 2);
  r.call('@CHATAPP-89874SAVE', { interval: 10, message: 'x', enable: false });
  r.tick(99 * 60000);
  clientSend(c2, M1, 'again');
  assert.equal(adminMsgs().length, 2, 'disabled: no reply');
});

test('a client message tells the admin page (the message and the unread map)', () => {
  const r = rig();
  const res = clientSend({ chat: r.chat, push: r.push }, M1, 'hi');
  assert.ok(res);
  const ev = r.pushed.map((p) => p[0]);
  assert.deepEqual(ev, ['@CHATAPP-96578', '@CHATAPP-0001']);
  assert.equal(r.pushed[0][1].mac, M1);
  assert.equal(clientSend({ chat: r.chat, push: r.push }, 'bad', 'x'), null);
});
