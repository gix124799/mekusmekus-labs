const test = require('node:test');
const assert = require('node:assert');
const { emptyConfig, timeForPesos, profileFor, cleanRow } = require('../lib/money/rates');

const table = (rows) => ({ set: { type: 0 }, rate: rows.map(([coin, minute, vendoset]) => ({ coin, minute, vendoset })) });

test('no table: the flat rate', () => {
  assert.equal(timeForPesos(emptyConfig(), 5, 1), 5 * 60000);
  assert.equal(timeForPesos(emptyConfig(), 1, 2), 30000);
});

test('bigger denominations earn their own bonus time; the remainder uses the smallest row\'s rate', () => {
  const t = table([[1, 300], [5, 1800], [10, 4200]]); // seconds
  assert.equal(timeForPesos(t, 1, 1), 300000);
  assert.equal(timeForPesos(t, 5, 1), 1800000, 'five pesos at once beats five single pesos (1500s)');
  assert.equal(timeForPesos(t, 16, 1), (4200 + 1800 + 300) * 1000);
  assert.equal(timeForPesos(table([[5, 1800]]), 7, 1), Math.round((1800 + (2 / 5) * 1800) * 1000), 'remainder pro rata');
});

test('cumulative: the grant for a growing batch never goes backwards', () => {
  const t = table([[1, 300], [5, 1800]]);
  let prev = 0;
  for (let p = 1; p <= 12; p++) { const ms = timeForPesos(t, p, 1); assert.ok(ms >= prev, `p=${p}`); prev = ms; }
});

test('rows with a zero coin or time are ignored (never a divide-by-zero or infinite time)', () => {
  assert.equal(timeForPesos(table([[0, 100], [5, 0]]), 3, 1), 3 * 60000);
});

test('profileFor picks the largest denomination that fits, else the smallest; consumable by default', () => {
  const t = table([[1, 300, { type: 'consumable', upload: '1M' }], [10, 4200, { type: 'pausable', upload: '5M', pauselimit: 3, validity: 24 }]]);
  assert.equal(profileFor(t, 12).upload, '5M');
  assert.equal(profileFor(t, 12).pauselimit, 3);
  assert.equal(profileFor(t, 3).upload, '1M');
  assert.equal(profileFor(t, 3).pauselimit, undefined);
  assert.equal(profileFor(t, 0.5).upload, '1M');
  assert.equal(profileFor(emptyConfig(), 5).type, 'consumable');
});

test('cleanRow validates the form and keeps pausable-only fields to pausable rows', () => {
  const ok = cleanRow({ coin: '5', minute: 1800, config: { type: 'pausable', upload: '2M', download: '3M', pauselimit: 2, validity: 12, notsametype: 1, max_data_limit: 1000 } });
  assert.deepEqual(ok, { coin: 5, minute: 1800, show: true, vendoset: { type: 'pausable', upload: '2M', download: '3M', validity: 12, pauselimit: 2, max_data_limit: 1000, notsametype: 1 } });
  assert.equal(cleanRow({ coin: 5, minute: 60, config: { type: 'consumable', pauselimit: 2 } }).vendoset.pauselimit, undefined);
  for (const bad of [{ coin: 0, minute: 60 }, { coin: 1.5, minute: 60 }, { coin: 'x', minute: 60 }, { coin: 5, minute: 0 }, { coin: 5, minute: -1 }, { coin: 5, minute: 'x' }, { coin: 5, minute: 60, config: { upload: '1' } }, { coin: 5, minute: 60, config: { download: 'fast' } }]) assert.ok(cleanRow(bad).err, JSON.stringify(bad));
});
