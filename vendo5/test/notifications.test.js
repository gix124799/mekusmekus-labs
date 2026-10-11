const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNotifications } = require('../lib/store/notifications');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5n-')), 'sub', 'notification.json');

test('add, list, mark read, clear', () => {
  let t = 0;
  const n = createNotifications({ file: file(), now: () => new Date(Date.UTC(2026, 9, 11, 0, 0, t++)) });
  assert.deepEqual(n.list(), {});
  n.add({ title: 'Hello', message: 'first' });
  const [date] = Object.keys(n.list());
  assert.deepEqual(n.list()[date], { title: 'Hello', icon: 'mdi-information-outline', message: 'first', read: false });
  assert.equal(date, String(Date.UTC(2026, 9, 11, 0, 0, 0)), 'the key is epoch milliseconds, which the page parseInt()s into a date');
  assert.equal(n.markRead(date), true);
  assert.equal(n.list()[date].read, true);
  assert.equal(n.markRead('946684800000'), false);
  n.clear();
  assert.deepEqual(n.list(), {});
});

test('keeps only the newest 50', () => {
  let t = 0;
  const n = createNotifications({ file: file(), now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)) });
  for (let i = 0; i < 55; i++) n.add({ title: `n${i}` });
  const all = n.list();
  assert.equal(Object.keys(all).length, 50);
  assert.equal(all[Object.keys(all).sort((a, b) => a - b)[0]].title, 'n5');
});

test('a corrupt or non-object file reads as empty', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (const bad of ['{nope', '[1,2]', 'null', '']) {
    fs.writeFileSync(f, bad);
    assert.deepEqual(createNotifications({ file: f }).list(), {}, bad);
  }
});

test('__proto__ as a date is not marked read', () => {
  const n = createNotifications({ file: file() });
  n.add({ title: 'x' });
  assert.equal(n.markRead('__proto__'), false);
});
