const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createResellers } = require('../lib/store/resellers');
const { createVouchers } = require('../lib/store/vouchers');
const { createCredits } = require('../lib/store/credits');
const { createTickets } = require('../lib/store/tickets');
const { createSales } = require('../lib/store/sales');
const { createSessions } = require('../lib/wire/session');
const { createResellerAdminHandlers, createResellerPortalHandlers } = require('../lib/wire/resellers');
const { createResellerRoutes } = require('../lib/ui/reseller-routes');
const { md5, splitToken } = require('../lib/wire/main');

const ROOT = require('./helpers/ui-root');
const PERM = (r, w) => ({ read: r, write: w });
const FULL = { vouchers: PERM(true, true), credits: PERM(true, true), cvused: PERM(true, false), sales: PERM(true, false), ticket: PERM(true, true) };
const VSET = { profile: 'hour', type: 0, length: 6, prefix: 'rs', upload: '2M', download: '5M', duration: 3600, price: 5 };
const CSET = { profile: 'ten', amount: 10, prefix: 'cr', length: 6 };

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5rs-'));
  const resellers = createResellers({ file: path.join(dir, 'r.json') });
  const vouchers = createVouchers({ file: path.join(dir, 'v.json') });
  const credits = createCredits({ file: path.join(dir, 'c.json') });
  const tickets = createTickets({ file: path.join(dir, 't.json') });
  const sales = createSales({ file: path.join(dir, 's.json') });
  const sessions = createSessions();
  const lines = [];
  let t = 1000;
  const mainlog = { write: (c, x) => lines.push(x) };
  const admin = createResellerAdminHandlers({ resellers, mainlog })['@nav-00112347'];
  const portal = createResellerPortalHandlers({ sessions, resellers, vouchers, credits, tickets, sales, licence: { deviceId: () => 'abcdef0123456789' }, mainlog, version: '1', now: () => t, makeToken: () => '0123456789abcdef0123456789abcdef' });
  const adm = (p) => admin.handler(p, {});
  const make = (over = {}) => adm({ action: 'ADD', username: 'Juan', password: 'secret99', limit: { voucher: { l: 10 }, credit: { l: 0 } }, permission: FULL, vouchertype: { pausable: false, consumable: true }, ...over });
  const login = (user = 'juan', pass = 'secret99') => {
    const session = sessions.create();
    const ctx = { session, ip: '1.2.3.4' };
    const token = portal['@sub-48931'].handler(user, ctx);
    const [a, b] = splitToken(token);
    const r = portal['@sub-66589'].handler({ username: md5(a + user.toLowerCase()), password: md5(b + pass) }, ctx);
    return { ctx, r };
  };
  const call = (id, ctx, p) => portal[id].handler(p, ctx);
  return { adm, make, login, call, resellers, vouchers, credits, tickets, sales, sessions, lines, tick: (ms) => { t += ms; }, dir, portal };
}

test('admin: add (name lowercased), duplicates and weak input refused, password change, remove', () => {
  const r = rig();
  assert.equal(r.make(), '');
  assert.deepEqual(Object.keys(r.adm({ action: 'GET' })), ['juan']);
  assert.equal(r.make().err, 'Username already exists');
  for (const bad of [{ username: 'ab' }, { username: 'bad name!' }, { username: '../x' }, { password: 'short' }, { password: 'has space1' }]) assert.ok(r.make(bad).err, JSON.stringify(bad));
  assert.equal(r.adm({ action: 'SET', username: 'juan', password: 'newsecret1' }), '');
  assert.equal(r.resellers.get('juan').password, 'newsecret1');
  assert.ok(r.adm({ action: 'SET', username: 'juan', password: 'x' }).err);
  assert.equal(r.adm({ action: 'REMOVE', username: 'juan' }), '');
  assert.equal(r.adm({ action: 'REMOVE', username: 'juan' }).err, 'Not found');
  for (const bad of [null, {}, { action: 'nuke' }]) assert.equal(r.adm(bad).err, 'Error');
});

test('admin: permissions and limits change, usage counters are not editable; profiles add/edit/remove with validation', () => {
  const r = rig();
  r.make();
  r.resellers.use('juan', 'voucher', 4);
  r.adm({ action: 'PERMISSION', username: 'juan', permission: { vouchers: PERM(true, false) }, vouchertype: { pausable: true }, limit: { voucher: { l: 20, u: 0 }, credit: { l: 5 } } });
  const a = r.resellers.get('juan');
  assert.deepEqual([a.permission.vouchers.write, a.permission.credits.read, a.vouchertype, a.limit.voucher, a.limit.credit], [false, false, { pausable: true, consumable: false }, { l: 20, u: 4 }, { l: 5, u: 0 }]);
  assert.deepEqual(r.adm({ action: 'SET-P', username: 'juan', H: 'voucher', voucherset: VSET, type: 'add' }), { success: true });
  assert.equal(r.adm({ action: 'SET-P', username: 'juan', H: 'voucher', voucherset: VSET, type: 'add' }).err, 'Profile already exists');
  assert.deepEqual(r.adm({ action: 'SET-P', username: 'juan', H: 'voucher', voucherset: { ...VSET, price: 9 }, type: 'edit' }), { success: true });
  assert.equal(r.resellers.get('juan').voucherset.hour.price, 9);
  assert.equal(r.adm({ action: 'SET-P', username: 'juan', H: 'voucher', voucherset: { ...VSET, profile: 'zzz' }, type: 'edit' }).err, 'Profile not found');
  for (const bad of [{ upload: '2' }, { duration: 0 }, { length: 3 }, { prefix: 'a-b' }, { profile: '' }, { price: -1 }]) assert.ok(r.adm({ action: 'SET-P', username: 'juan', H: 'voucher', voucherset: { ...VSET, profile: 'p2', ...bad }, type: 'add' }).err, JSON.stringify(bad));
  assert.deepEqual(r.adm({ action: 'SET-P', username: 'juan', H: 'credit', creditset: CSET, type: 'add' }), { success: true });
  assert.ok(r.adm({ action: 'SET-P', username: 'juan', H: 'credit', creditset: { ...CSET, profile: 'x', length: 9 }, type: 'add' }).err);
  assert.deepEqual(r.adm({ action: 'SET-P', username: 'juan', H: 'voucher', voucherset: { profile: 'hour' }, type: 'remove' }), { success: true });
  assert.equal(r.adm({ action: 'SET-P', username: 'juan', H: 'voucher', voucherset: { profile: 'hour' }, type: 'remove' }).err, 'Profile not found');
  assert.equal(r.adm({ action: 'SET-P', username: 'ghost', H: 'voucher', voucherset: VSET, type: 'add' }).err, 'Not found');
});

test('login: right password works (any case/space in the name), wrong password / unknown user / replay / stale challenge fail', () => {
  const r = rig();
  r.make();
  assert.deepEqual(r.login('Juan ').r, { login: false }, 'the name the page sends has its spaces stripped; this raw one does not match its own hash');
  assert.deepEqual(r.login('juan').r, { login: true });
  assert.deepEqual(r.login('juan', 'wrong').r, { login: false });
  assert.deepEqual(r.login('nobody').r, { login: false });
  const { ctx } = r.login();
  assert.deepEqual(r.portal['@sub-66589'].handler({ username: 'x', password: 'y' }, ctx), { login: false }, 'the challenge is single use');
  const s = r.sessions.create();
  const c2 = { session: s, ip: 'x' };
  const token = r.portal['@sub-48931'].handler('juan', c2);
  const [a, b] = splitToken(token);
  r.tick(5000);
  assert.deepEqual(r.portal['@sub-66589'].handler({ username: md5(a + 'juan'), password: md5(b + 'secret99') }, c2), { login: false }, 'older than 3 seconds');
  assert.ok(r.lines.some((l) => /Reseller Success Login: user juan/.test(l)) && r.lines.some((l) => /Reseller Failed Login/.test(l)));
  assert.equal(r.portal['@sub-66322'].handler().prefix, 'abcdef01');
  for (const [id, d] of Object.entries(r.portal)) assert.equal(d.guard, !['@sub-66322', '@sub-48931', '@sub-66589'].includes(id), id);
});

test('voucher generation: only from a granted profile, within type permission and limit; owner is the reseller; scoped lists; remove frees the limit', () => {
  const r = rig();
  r.make({ limit: { voucher: { l: 5 }, credit: { l: 0 } } });
  r.adm({ action: 'SET-P', username: 'juan', H: 'voucher', voucherset: VSET, type: 'add' });
  const { ctx } = r.login();
  const form = { type: '0', qty: 3, length: 6, random: true, prefix: 'RS', upload: '2M', download: '5M', duration: 3600, price: 5, owner: 'someoneelse' };
  const g = r.call('@sub-96547', ctx, form);
  assert.equal(g.message, 'Done');
  assert.ok(g.newvoucher.every((v) => v.genfrom === 'juan' && /^RS/.test(v.code)), 'the owner cannot be chosen by the client');
  assert.equal(r.call('@sub-889661', ctx).limit.voucher.u, 3);
  assert.equal(r.call('@sub-96547', ctx, { ...form, qty: 3 }).err, 'Voucher limit reached');
  assert.equal(r.call('@sub-889661', ctx).limit.voucher.u, 3, 'a refused request counts nothing');
  assert.match(r.call('@sub-96547', ctx, { ...form, price: 0 }).err, /not allowed/, 'a cheaper price than the profile is refused');
  assert.match(r.call('@sub-96547', ctx, { ...form, duration: 999999 }).err, /not allowed/);
  assert.match(r.call('@sub-96547', ctx, { ...form, type: '1' }).err, /pausable vouchers are not allowed/);
  assert.equal(r.call('@sub-96547', ctx, { ...form, qty: 0 }).err, 'Invalid quantity');
  r.vouchers.generate({ type: '0', qty: 1, length: 6, random: true, prefix: 'AD', upload: '1M', download: '1M', duration: 60, owner: 'Admin1', price: 1 });
  const mine = r.call('@sub-234423', ctx).vouchers;
  assert.equal(Object.keys(mine).length, 3, "another owner's vouchers are invisible");
  const [c1, c2] = Object.keys(mine);
  const adminCode = Object.keys(r.vouchers.list()).find((c) => c.startsWith('AD'));
  r.call('@sub-52212', ctx, { [c1]: true, [adminCode]: true });
  assert.ok(r.vouchers.get(adminCode), "removing another owner's voucher does nothing");
  assert.equal(r.vouchers.get(c1), null);
  assert.equal(r.call('@sub-889661', ctx).limit.voucher.u, 2, 'removal frees the limit');
  assert.equal(r.call('@sub-889661', ctx).password, undefined, 'the password is never sent back');
});

test('credit generation mirrors it: profile-bound, limited, scoped; used lists show only their own', () => {
  const r = rig();
  r.make({ limit: { voucher: { l: 0 }, credit: { l: 4 } } });
  r.adm({ action: 'SET-P', username: 'juan', H: 'credit', creditset: CSET, type: 'add' });
  const { ctx } = r.login();
  const codes = r.call('@sub-36200', ctx, { quantity: 3, amount: 10, prefix: 'CR', length: 6 });
  assert.equal(Object.keys(codes).length, 3);
  assert.ok(Object.values(codes).every((c) => c.name === 'juan'));
  assert.equal(r.call('@sub-36200', ctx, { quantity: 3, amount: 10, prefix: 'CR', length: 6 }).err, 'Credit limit reached');
  assert.match(r.call('@sub-36200', ctx, { quantity: 1, amount: 1000, prefix: 'CR', length: 6 }).err, /not allowed/);
  const [c1] = Object.keys(codes);
  r.credits.markUsed(r.credits.get(c1), 'm1');
  r.credits.markUsed({ code: 'ZZ', amount: 5, name: 'other' }, 'm2');
  const used = r.call('@sub-34400', ctx, { action: 'GET', type: 'credit' }).split('\n');
  assert.equal(used.length, 1);
  assert.equal(JSON.parse(used[0]).code, c1);
  r.call('@sub-35532', ctx, [Object.keys(codes)[1], 'ZZ']);
  assert.equal(r.call('@sub-889661', ctx).limit.credit.u, 2);
});

test('permissions are enforced per area: no write, no read, no ticket, no sales', () => {
  const r = rig();
  r.make({ permission: { vouchers: PERM(true, false), credits: PERM(false, false), cvused: PERM(false, false), sales: PERM(false, false), ticket: PERM(false, false) } });
  r.adm({ action: 'SET-P', username: 'juan', H: 'voucher', voucherset: VSET, type: 'add' });
  const { ctx } = r.login();
  assert.equal(r.call('@sub-96547', ctx, { type: '0', qty: 1, upload: '2M', download: '5M', duration: 3600, price: 5, prefix: 'RS' }).err, 'Not permitted');
  assert.deepEqual(r.call('@sub-234423', ctx), { vouchers: {}, credits: {} });
  assert.equal(r.call('@sub-34400', ctx, { action: 'GET', type: 'voucher' }), '');
  assert.deepEqual(r.call('@sub-55685', ctx), {});
  assert.equal(r.call('@sub-29903', ctx, { name: 'voucher', data: [['x']] }), '');
  assert.equal(r.call('@sub-0021145', ctx, { action: 'GET' }), 'Error');
  assert.equal(r.call('@sub-36200', ctx, { quantity: 1, amount: 10, prefix: 'CR', length: 6 }).err, 'Not permitted');
  const none = r.sessions.create();
  assert.equal(r.call('@sub-889611', { session: none }), '', 'a session that is not a reseller has no name');
  assert.deepEqual(r.call('@sub-889661', { session: none }), {});
});

test('tickets are per reseller; sales are their own and read-only; password change checks the old one', () => {
  const r = rig();
  r.make();
  r.make({ username: 'pedro' });
  const a = r.login().ctx;
  const b = r.login('pedro').ctx;
  const name = r.call('@sub-29903', a, { name: 'voucher', title: 'Mine', price: 5, data: [['A']] });
  assert.match(name, /^voucher-\d+$/);
  assert.deepEqual(Object.keys(r.call('@sub-55685', a)), [name]);
  assert.deepEqual(r.call('@sub-55685', b), {});
  assert.equal(r.call('@sub-55699', b, name), '');
  assert.equal(r.call('@sub-23466', b, name), 'Error');
  assert.equal(r.call('@sub-23466', a, name), 'Success');
  r.sales.add({ kind: 'voucher', amount: 5, owner: 'juan', mac: 'm' });
  r.sales.add({ kind: 'voucher', amount: 7, owner: 'pedro', mac: 'm' });
  r.sales.add({ kind: 'credit', amount: 10, owner: 'juan', mac: 'm' });
  const s = r.call('@sub-0021145', a, { action: 'GET' });
  assert.deepEqual([Object.keys(s._vouchersales), Object.values(s._vouchersales.juan)[0], Object.values(s._creditsales.juan)[0]], [['juan'], 5, 10]);
  assert.equal(r.call('@sub-0021145', a, { action: 'CLEAR', type: '_vouchersales', name: 'juan' }), 'Error');
  assert.equal(r.sales.all().length, 3, 'a reseller cannot clear the books');
  assert.equal(r.call('@sub-84472', a, { oldtpass: 'wrong', cnewpass: 'newsecret1' }), 'Invalid Password');
  assert.equal(r.call('@sub-84472', a, { oldtpass: 'secret99', cnewpass: 'x' }), 'Password must be 6-32 characters, no spaces');
  assert.equal(r.call('@sub-84472', a, { oldtpass: 'secret99', cnewpass: 'newsecret1' }), 'Success');
  assert.equal(r.login('juan', 'newsecret1').r.login, true);
});

async function web(rs, { permission = FULL } = {}) {
  const r = rs;
  r.make({ permission });
  const handle = createResellerRoutes({ root: ROOT, version: '1', hostname: 'ethylnet', sessions: r.sessions, resellers: r.resellers });
  const server = http.createServer((q, s) => { if (!handle(q, s)) s.writeHead(404).end(); });
  await new Promise((x) => server.listen(0, x));
  const port = server.address().port;
  const call = (method, p, { cookie, body, type } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (type) headers['Content-Type'] = type;
    const q = http.request({ port, method, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    q.on('error', reject);
    q.end(body);
  });
  return { call, stop: () => server.close() };
}

test('portal pages: login page (no plaintext field names), then the shell with only the readable menu entries, logout', async () => {
  const r = rig();
  const w = await web(r, { permission: { vouchers: PERM(true, true), credits: PERM(false, false), cvused: PERM(false, false), sales: PERM(true, false), ticket: PERM(true, false) } });
  try {
    const first = await w.call('GET', '/reseller');
    assert.match(first.headers['set-cookie'][0], /^vendo5_rsid=[0-9a-f]+; HttpOnly; SameSite=Strict; Path=\/reseller/);
    assert.ok(/login-btn/.test(first.body));
    assert.ok(!/name="sub-(username|password)"/.test(first.body), 'the password cannot ride in the form post');
    assert.ok(!first.body.includes('{2}'));
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    r.sessions.allow(r.sessions.get(cookie.split('=')[1]));
    assert.ok(/login-btn/.test((await w.call('GET', '/reseller?page=vouchers', { cookie })).body), 'allowed but not a reseller yet: still the login page');
    r.sessions.get(cookie.split('=')[1]).user = 'juan';
    const home = await w.call('GET', '/reseller', { cookie });
    assert.equal(home.headers.location, '/reseller?page=vouchers', 'lands on the first readable page');
    const shell = await w.call('GET', '/reseller?page=vouchers', { cookie });
    assert.equal(shell.status, 200);
    assert.ok(shell.body.includes('script/vouchers.js'));
    assert.ok(shell.body.includes('page=sales') && !shell.body.includes('page=credit'), 'only readable pages are in the menu');
    assert.equal((await w.call('GET', '/reseller?page=credit', { cookie })).headers.location, '/reseller?page=vouchers', 'an unreadable page bounces');
    assert.ok((await w.call('GET', '/reseller?page=ticket&file=voucher-1', { cookie })).body.includes('script/ticket.js'));
    assert.equal((await w.call('POST', '/reseller?login=true', { cookie, body: '', type: 'application/x-www-form-urlencoded' })).headers.location, '/reseller');
    assert.equal((await w.call('POST', '/reseller?', { cookie, body: '{"logout":true}', type: 'application/json' })).status, 200);
    assert.ok(/login-btn/.test((await w.call('GET', '/reseller?page=vouchers', { cookie })).body));
  } finally { w.stop(); }
});
