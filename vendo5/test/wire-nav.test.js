const test = require('node:test');
const assert = require('node:assert');
const { createNavHandlers } = require('../lib/wire/nav');
const { createSessionStore } = require('../lib/session');

function setup(over = {}) {
  const sessions = createSessionStore('/nonexistent/s.json');
  sessions.load();
  const lines = [];
  const revoked = [];
  const saved = [];
  const state = { cleared: 0, accountReset: 0, notes: { d1: { title: 't', read: false } }, marked: [] };
  const nav = createNavHandlers({
    sessions,
    firewall: { revoke: (m) => { if (over.revokeThrows) throw new Error('not in set'); revoked.push(m); } },
    arp: { neighbors: () => ({ 'aa:bb:cc:dd:ee:01': { ip: '10.0.0.5', dev: 'br-lan' } }) },
    stats: { snapshot: () => ({ cpuusage: [1, 2], temp: 40 }) },
    passthrough: (p) => ({ ran: p }),
    mainlog: { write: (c, t) => lines.push(`${c}|${t}`), list: () => ['system-05-10-2026.txt'], read: (n) => `read ${n}`, remove: (n) => ({ success: true, n }), removeByCategory: (c) => lines.push(`cat|${c}`) },
    notifications: { list: () => state.notes, markRead: (d) => state.marked.push(d), clear: () => { state.cleared++; } },
    licence: { licence: () => ({ serial: 'SER1', hotspot: 1000000, pppoe: 1000000, movie: true, expiration: 8640000000000000 }) },
    account: { reset: () => { state.accountReset++; } },
    now: () => 100000,
    save: () => saved.push(1),
  });
  return { nav, sessions, lines, revoked, saved, state };
}
const call = (nav, id, payload) => nav[id].handler(payload, {});

test('every nav event is guarded', () => {
  const { nav } = setup();
  for (const [id, def] of Object.entries(nav)) assert.equal(def.guard, true, id);
});

test('dashboard: stats plus the active sessions in the shapes the page reads', () => {
  const { nav, sessions } = setup();
  sessions.addCredit('aa:bb:cc:dd:ee:01', 2, 1, 40000); // expires 160000
  sessions.addCredit('aa:bb:cc:dd:ee:02', 1, 1, 90000);
  const r = call(nav, '@nav-89554', { getSessionList: true });
  assert.deepEqual(r.cpuusage, [1, 2]);
  assert.equal(r.now, 100000);
  assert.deepEqual(r.Watching, {});
  assert.deepEqual(r.pppoelist, { accounts: {}, active: {} });
  const d = r.active.data['aa:bb:cc:dd:ee:01'];
  assert.equal(d.expiration, 160000);
  assert.equal(d.logindate, 40000);
  assert.equal(d.duration, 120);
  assert.equal(d.type, 'consumable');
  assert.equal(typeof d.uploadLimit, 'string', 'the page calls toLowerCase() on the limits');
  assert.equal(typeof d.downloadLimit, 'string');
  assert.deepEqual(r.active.session['aa:bb:cc:dd:ee:01'], { mac: 'aa:bb:cc:dd:ee:01', address: '10.0.0.5', ifname: 'br-lan', brlan: 'br-lan', uptime: 60, idle: 0, upload: 0, download: 0, rx: 0, tx: 0 });
  assert.equal(r.active.session['aa:bb:cc:dd:ee:02'].address, '', 'a client the ARP table does not know still lists');
  assert.deepEqual(r.active.sessionList, {});
});

test('dashboard with no sessions', () => {
  const r = call(setup().nav, '@nav-89554', undefined);
  assert.deepEqual(r.active, { data: {}, session: {}, sessionList: {} });
});

test('passthrough, name lookup, licence, serial, redeem', () => {
  const { nav } = setup();
  assert.deepEqual(call(nav, '@nav-23441', 'ubus call system info'), { ran: 'ubus call system info' });
  const l = call(nav, '@nav-232003');
  assert.equal(l.status, 'activated');
  assert.equal(l.code, 'SER1');
  assert.equal(l.hotspot, 1000000);
  assert.equal(call(nav, '@nav-1452357'), Buffer.from('SER1').toString('base64'));
  const r = call(nav, '@nav-14433223', { voucher: 'x', email: 'a@b.c', name: 'n' });
  assert.equal(r.success, false);
  assert.match(r.message, /offline/);
});

test('extend adds seconds to a live session and logs; unknown or bad input is Error', () => {
  const { nav, sessions, lines, saved } = setup();
  sessions.addCredit('m1', 1, 1, 50000); // expires 110000
  assert.equal(call(nav, '@nav-89000', { voucher: 'm1', duration: 3600 }), 'Success');
  assert.equal(sessions.getSession('m1').expiresAt, 110000 + 3600000);
  assert.equal(saved.length, 1);
  assert.match(lines[0], /^system\|Admin extended m1 by 3600s$/);
  for (const bad of [{ voucher: 'nobody', duration: 60 }, { voucher: 'm1', duration: 0 }, { voucher: 'm1', duration: 'x' }, { voucher: 'm1' }, null, 'm1', 7]) assert.equal(call(nav, '@nav-89000', bad), 'Error', JSON.stringify(bad));
});

test('remove ends the session and the firewall entry; a firewall that never knew the mac still lets it go', () => {
  const a = setup();
  a.sessions.addCredit('m1', 1, 1, 50000);
  assert.equal(call(a.nav, '@nav-44232', { mac: 'm1' }), 'Success');
  assert.deepEqual(a.revoked, ['m1']);
  assert.equal(a.sessions.getSession('m1'), undefined);
  assert.equal(call(a.nav, '@nav-44232', { mac: 'm1' }), 'Error', 'already gone');
  const b = setup({ revokeThrows: true });
  b.sessions.addCredit('m1', 1, 1, 50000);
  assert.equal(call(b.nav, '@nav-44232', { mac: 'm1' }), 'Success');
  assert.equal(b.sessions.getSession('m1'), undefined);
});

test('bulk remove takes {info:[...]} or a bare array of items or macs', () => {
  const t = setup();
  for (const m of ['m1', 'm2', 'm3']) t.sessions.addCredit(m, 1, 1, 50000);
  assert.equal(call(t.nav, '@nav-67345', { info: [{ mac: 'm1' }] }), 'Success');
  assert.equal(call(t.nav, '@nav-67345', [{ mac: 'm2' }, 'm3', { mac: 'zzz' }]), 'Success');
  assert.deepEqual(Object.keys(t.sessions.all()), []);
  for (const bad of [[], {}, { info: 'm1' }, null, 'm1', 3]) assert.equal(call(t.nav, '@nav-67345', bad), 'Error', JSON.stringify(bad));
});

test('disconnect is unavailable, and says so rather than ending the session', () => {
  const t = setup();
  t.sessions.addCredit('m1', 1, 1, 50000);
  assert.equal(call(t.nav, '@nav-22313', { mac: 'm1' }), 'Error');
  assert.ok(t.sessions.getSession('m1'));
});

test('logs: list, read, delete one, delete a category', () => {
  const t = setup();
  assert.deepEqual(call(t.nav, '@nav-645798'), ['system-05-10-2026.txt']);
  assert.equal(call(t.nav, '@nav-636547', 'system-05-10-2026.txt'), 'read system-05-10-2026.txt');
  assert.deepEqual(call(t.nav, '@nav-362358', 'system-05-10-2026.txt'), { success: true, n: 'system-05-10-2026.txt' });
  assert.deepEqual(call(t.nav, '@nav-365478', 'voucher'), {});
  assert.ok(t.lines.includes('cat|voucher'));
});

test('notifications: list, mark read by date, clear', () => {
  const t = setup();
  assert.deepEqual(call(t.nav, '@nav-63658987'), t.state.notes);
  call(t.nav, '@nav-3265892', { date: 'd1', read: true });
  call(t.nav, '@nav-3265892', null);
  assert.deepEqual(t.state.marked, ['d1', undefined]);
  call(t.nav, '@nav-3654780');
  assert.equal(t.state.cleared, 1);
});

test('factory reset ends all sessions, restores the default login, clears notices, and logs it', () => {
  const t = setup({ revokeThrows: true });
  t.sessions.addCredit('m1', 1, 1, 50000);
  t.sessions.addCredit('m2', 1, 1, 50000);
  assert.equal(call(t.nav, '@nav-3332145'), 'Success');
  assert.deepEqual(t.sessions.all(), {});
  assert.equal(t.state.accountReset, 1);
  assert.equal(t.state.cleared, 1);
  assert.ok(t.lines.some((l) => /reset the device/.test(l)));
});

test('remove accepts the code a running voucher carries, as one string or in a list', () => {
  const t = setup();
  t.sessions.addTime('m1', 60000, { code: 'AAA111' }, 50000);
  t.sessions.addTime('m2', 60000, { code: 'BBB222' }, 50000);
  assert.equal(call(t.nav, '@nav-67345', { info: 'AAA111' }), 'Success');
  assert.equal(t.sessions.getSession('m1'), undefined);
  assert.equal(call(t.nav, '@nav-44232', { code: 'x', mac: 'BBB222' }), 'Success');
  assert.equal(t.sessions.getSession('m2'), undefined);
});
