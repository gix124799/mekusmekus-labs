const test = require('node:test');
const assert = require('node:assert');
const { log } = require('../lib/logger');

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
