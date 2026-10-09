const test = require('node:test');
const assert = require('node:assert');
const { createAdminAuth, hashPassword } = require('../lib/admin');

test('login with correct username/password returns a token', () => {
  const auth = createAdminAuth({ username: 'admin', passwordHash: hashPassword('secret') });
  const token = auth.login('admin', 'secret');
  assert.ok(typeof token === 'string' && token.length > 0);
});

test('login with wrong password returns null', () => {
  const auth = createAdminAuth({ username: 'admin', passwordHash: hashPassword('secret') });
  assert.equal(auth.login('admin', 'wrong'), null);
});

test('login with wrong username returns null', () => {
  const auth = createAdminAuth({ username: 'admin', passwordHash: hashPassword('secret') });
  assert.equal(auth.login('nobody', 'secret'), null);
});

test('verify returns true for a token from a successful login', () => {
  const auth = createAdminAuth({ username: 'admin', passwordHash: hashPassword('secret') });
  const token = auth.login('admin', 'secret');
  assert.equal(auth.verify(token), true);
});

test('verify returns false for an unknown token', () => {
  const auth = createAdminAuth({ username: 'admin', passwordHash: hashPassword('secret') });
  assert.equal(auth.verify('not-a-real-token'), false);
});

test('verify returns false for no token', () => {
  const auth = createAdminAuth({ username: 'admin', passwordHash: hashPassword('secret') });
  assert.equal(auth.verify(undefined), false);
  assert.equal(auth.verify(null), false);
});

test('logout invalidates the token', () => {
  const auth = createAdminAuth({ username: 'admin', passwordHash: hashPassword('secret') });
  const token = auth.login('admin', 'secret');
  auth.logout(token);
  assert.equal(auth.verify(token), false);
});

test('two different logins produce two different tokens', () => {
  const auth = createAdminAuth({ username: 'admin', passwordHash: hashPassword('secret') });
  const t1 = auth.login('admin', 'secret');
  const t2 = auth.login('admin', 'secret');
  assert.notEqual(t1, t2);
  assert.equal(auth.verify(t1), true);
  assert.equal(auth.verify(t2), true);
});

test('hashPassword is deterministic and not plaintext', () => {
  assert.equal(hashPassword('secret'), hashPassword('secret'));
  assert.notEqual(hashPassword('secret'), 'secret');
});
