const test = require('node:test');
const assert = require('node:assert');
const { log, getRecent } = require('../lib/logger');

const sink = () => { const s = { data: '', write(c) { this.data += c; } }; return s; };

test('writes one JSON line with ts, level, message, fields', () => {
  const out = sink();
  log('info', 'hello', { a: 1 }, out);
  assert.ok(out.data.endsWith('\n'));
  const o = JSON.parse(out.data);
  assert.equal(o.level, 'info');
  assert.equal(o.message, 'hello');
  assert.equal(o.a, 1);
  assert.ok(!Number.isNaN(Date.parse(o.ts)));
});

test('fields cannot overwrite level/message/ts', () => {
  const out = sink();
  log('warn', 'm', { level: 'x', message: 'y', ts: 'z' }, out);
  const o = JSON.parse(out.data);
  assert.equal(o.level, 'warn');
  assert.equal(o.message, 'm');
  assert.notEqual(o.ts, 'z');
});

test('unknown level throws', () => {
  assert.throws(() => log('trace', 'm', {}, sink()), /level/);
});

test('getRecent returns entries pushed by log, oldest first', () => {
  const before = getRecent().length;
  log('info', 'first', {}, sink());
  log('info', 'second', {}, sink());
  const recent = getRecent();
  assert.equal(recent.length, before + 2);
  assert.equal(recent[recent.length - 2].message, 'first');
  assert.equal(recent[recent.length - 1].message, 'second');
});

test('getRecent caps at 500 entries and drops the oldest first', () => {
  // ruling: `recent` is a module-level singleton shared by every test in this
  // process (by design -- see lib/logger.js), so the buffer already holds
  // entries from earlier tests when this one starts. Compute the expected
  // surviving window from the actual pre-existing content plus what this
  // test pushes, instead of assuming an empty buffer or guessing an index.
  const before = getRecent();
  const pushed = [];
  for (let i = 0; i < 520; i++) {
    log('info', `msg-${i}`, {}, sink());
    pushed.push(`msg-${i}`);
  }
  const recent = getRecent();
  assert.equal(recent.length, 500);
  const expectedMessages = [...before.map((e) => e.message), ...pushed].slice(-500);
  assert.deepEqual(recent.map((e) => e.message), expectedMessages);
});

test('getRecent entries are independent of what out receives', () => {
  const out = sink();
  log('warn', 'only-to-buffer-and-out', { x: 1 }, out);
  const recent = getRecent();
  const last = recent[recent.length - 1];
  assert.equal(last.message, 'only-to-buffer-and-out');
  assert.equal(last.x, 1);
  assert.ok(out.data.includes('only-to-buffer-and-out')); // out still got it too
});
