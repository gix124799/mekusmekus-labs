const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountStore } = require('../lib/store/account');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5acct-')), 'state', 'account.json');

test('first load creates the factory account, mode 0600, and reports it', () => {
  const file = tmp();
  const a = createAccountStore(file);
  assert.equal(a.load(), true);
  assert.deepEqual(a.get(), { username: 'admin', password: 'admin' });
  assert.equal(a.isFactoryDefault(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { main: { username: 'admin', password: 'admin' } });
});

test('a stored account is loaded back and is not reported as created', () => {
  const file = tmp();
  const a = createAccountStore(file);
  a.load();
  assert.equal(a.change({ username: 'boss', oldPassword: 'admin', newPassword: 'hunter22' }), true);
  const b = createAccountStore(file);
  assert.equal(b.load(), false);
  assert.deepEqual(b.get(), { username: 'boss', password: 'hunter22' });
  assert.equal(b.isFactoryDefault(), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'still 0600 after a rewrite');
});

test('change refuses a wrong old password and empty values, and changes nothing', () => {
  const a = createAccountStore(tmp());
  a.load();
  assert.equal(a.change({ username: 'x', oldPassword: 'nope', newPassword: 'abcdefgh' }), false);
  assert.equal(a.change({ username: 'x', oldPassword: 'admin', newPassword: '' }), false);
  assert.equal(a.change({ username: '', oldPassword: 'admin', newPassword: 'abcdefgh' }), false);
  assert.equal(a.change({ username: 'x', oldPassword: 'admin', newPassword: 42 }), false);
  assert.deepEqual(a.get(), { username: 'admin', password: 'admin' });
});

test('a corrupt or half-formed file is replaced by the factory account, not trusted', () => {
  for (const content of ['{not json', '{}', '{"main":{"username":"x"}}', '[]', '']) {
    const file = tmp();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const a = createAccountStore(file);
    assert.equal(a.load(), true, content);
    assert.equal(a.isFactoryDefault(), true);
  }
});

test('writes are atomic: no temp file is left behind and get() returns a copy', () => {
  const file = tmp();
  const a = createAccountStore(file);
  a.load();
  a.change({ username: 'u', oldPassword: 'admin', newPassword: 'p' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['account.json']);
  a.get().password = 'tampered';
  assert.equal(a.get().password, 'p');
});

test('reset restores the factory account on disk', () => {
  const file = tmp();
  const a = createAccountStore(file);
  a.load();
  a.change({ username: 'u', oldPassword: 'admin', newPassword: 'p' });
  a.reset();
  assert.equal(createAccountStore(file).load(), false);
  assert.equal(a.isFactoryDefault(), true);
});
