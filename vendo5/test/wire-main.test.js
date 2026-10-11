const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSessions } = require('../lib/wire/session');
const { createMainHandlers, splitToken } = require('../lib/wire/main');

// The vendor's own browser MD5 (the file the login page loads), run in a sandbox: the client side.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(require('./helpers/ui-root'), 'main', 'js', 'md5.js'), 'utf8'), sandbox);
const hexMD5 = (s) => sandbox.hexMD5(s);

// The login page's own expressions (main/script/main.js), verbatim in meaning.
function browserLogin(token, typedUser, typedPass) {
  return {
    uname: typedUser,
    username: hexMD5(token.substring(0, (token.length - 1) / 2) + typedUser.toLowerCase().replace(/\s/g, '')),
    password: hexMD5(token.substring((token.length - 1) / 2, token.length) + typedPass.replace(/\s/g, '')),
  };
}

function rig({ username = 'admin', password = 'admin', start = 1000000 } = {}) {
  let t = start;
  const writes = [];
  const sessions = createSessions({ now: () => t });
  const account = { get: () => ({ username, password }), change: (a) => { if (a.oldPassword !== password) return false; username = a.username; password = a.newPassword; return true; } };
  const h = createMainHandlers({
    account, sessions, mainlog: { write: (c, l) => writes.push([c, l]) }, version: '9.9.9', licence: { deviceId: () => 'abcdef0123456789' },
    now: () => t, makeToken: () => 'a'.repeat(15) + 'b'.repeat(17),
  });
  const session = sessions.create();
  const ctx = { session, ip: '10.0.0.7' };
  return { h, sessions, session, ctx, writes, advance: (ms) => { t += ms; } };
}

test('the server and the vendor browser MD5 agree on the hash of the same input', () => {
  const { md5 } = require('../lib/wire/main');
  for (const s of ['', 'a', 'admin', 'tokenhalfadmin', 'päss wörd', 'é', 'パス', 'a😀b', 'x'.repeat(200)]) {
    assert.equal(hexMD5(s), md5(s), JSON.stringify(s));
  }
});

test('login succeeds with the browser-computed hashes (typed with spaces and capitals)', () => {
  const r = rig({ username: 'admin', password: 'secret99' });
  const token = r.h['@main-48931'].handler(null, r.ctx);
  assert.equal(token.length, 32);
  const reply = r.h['@main-66589'].handler(browserLogin(token, ' Ad Min ', 'sec ret99'), r.ctx);
  assert.deepEqual(reply, { login: true });
  assert.equal(r.session.allowed, true);
  assert.deepEqual(r.writes[0], ['system', 'Admin Success Login: user  Ad Min  from 10.0.0.7']);
});

test('a non-ASCII password logs in (the browser hashes low bytes, not UTF-8)', () => {
  for (const pw of ['päss wörd1', 'パスワード99', 'pass😀word']) {
    const r = rig({ password: pw });
    const token = r.h['@main-48931'].handler(null, r.ctx);
    assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', pw), r.ctx), { login: true }, pw);
  }
});

test('wrong password and wrong username both fail and are logged', () => {
  const r = rig();
  let token = r.h['@main-48931'].handler(null, r.ctx);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', 'nope'), r.ctx), { login: false });
  token = r.h['@main-48931'].handler(null, r.ctx);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'root', 'admin'), r.ctx), { login: false });
  assert.equal(r.session.allowed, false);
  assert.equal(r.writes.length, 2);
  assert.match(r.writes[0][1], /^Admin Failed Login: user admin invalid user or password from 10\.0\.0\.7$/);
});

test('a token is single-use: replaying the same correct answer fails', () => {
  const r = rig();
  const token = r.h['@main-48931'].handler(null, r.ctx);
  const answer = browserLogin(token, 'admin', 'admin');
  assert.deepEqual(r.h['@main-66589'].handler(answer, r.ctx), { login: true });
  r.session.allowed = false;
  assert.deepEqual(r.h['@main-66589'].handler(answer, r.ctx), { login: false });
});

test('a failed attempt also burns the token', () => {
  const r = rig();
  const token = r.h['@main-48931'].handler(null, r.ctx);
  r.h['@main-66589'].handler(browserLogin(token, 'admin', 'wrong'), r.ctx);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', 'admin'), r.ctx), { login: false });
});

test('the 3 second freshness window: 2999 ms passes, 3000 ms fails', () => {
  let r = rig();
  let token = r.h['@main-48931'].handler(null, r.ctx);
  r.advance(2999);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', 'admin'), r.ctx), { login: true });
  r = rig();
  token = r.h['@main-48931'].handler(null, r.ctx);
  r.advance(3000);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', 'admin'), r.ctx), { login: false });
});

test('verify without asking for a token, or with no session, fails safely', () => {
  const r = rig();
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin('x'.repeat(32), 'admin', 'admin'), r.ctx), { login: false });
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin('x'.repeat(32), 'admin', 'admin'), { session: null, ip: '1.1.1.1' }), { login: false });
  assert.equal(r.h['@main-48931'].handler(null, { session: null }), '');
});

for (const bad of [null, undefined, 'str', 42, [], {}, { username: 1, password: 2 }, { username: 'x' }]) {
  test(`malformed verify payload ${JSON.stringify(bad)} is a failed login, never an exception`, () => {
    const r = rig();
    r.h['@main-48931'].handler(null, r.ctx);
    assert.deepEqual(r.h['@main-66589'].handler(bad, r.ctx), { login: false });
  });
}

test('splitToken matches the browser expression for even and odd lengths', () => {
  for (const len of [31, 32, 1, 2, 3]) {
    const token = 'abcdefghijklmnopqrstuvwxyz012345'.repeat(2).slice(0, len);
    const [a, b] = splitToken(token);
    assert.equal(a, token.substring(0, (token.length - 1) / 2));
    assert.equal(b, token.substring((token.length - 1) / 2, token.length));
  }
  assert.deepEqual(splitToken('x'.repeat(32)).map((s) => s.length), [15, 17], 'substring(15.5, 32) starts at 15, so the second half is the longer one');
});

test('login page version banner and the change-password dialog', () => {
  const r = rig({ password: 'oldpass99' });
  assert.deepEqual(r.h['@main-66322'].handler(null, r.ctx), { version: '9.9.9', prefix: 'abcdef01' });
  assert.equal(r.h['@main-84472'].handler({ username: 'boss', oldtpass: 'wrong', cnewpass: 'newpass99' }, r.ctx), 'Invalid Password');
  assert.equal(r.h['@main-84472'].handler({ username: 'boss', oldtpass: 'oldpass99', cnewpass: 'newpass99' }, r.ctx), 'Success');
  assert.equal(r.h['@main-84472'].handler(null, r.ctx), 'Invalid Password');
});

test('only the change-password event needs a logged-in session', () => {
  const h = rig().h;
  assert.deepEqual(Object.entries(h).map(([id, d]) => [id, d.guard]).sort(), [['@main-48931', false], ['@main-66322', false], ['@main-66589', false], ['@main-84472', true]]);
});
