const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGpio } = require('../lib/gpio');

function fakeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v5gpio-'));
  fs.writeFileSync(path.join(base, 'export'), '');
  fs.writeFileSync(path.join(base, 'unexport'), '');
  return base;
}
function makePin(base, n, value = '0') {
  const d = path.join(base, `gpio${n}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'value'), value);
  fs.writeFileSync(path.join(d, 'direction'), '');
  fs.writeFileSync(path.join(d, 'edge'), '');
  return d;
}

test('exportPin writes pin number to export', () => {
  const base = fakeBase();
  createGpio(base).exportPin(17);
  assert.equal(fs.readFileSync(path.join(base, 'export'), 'utf8'), '17');
});

test('unexportPin writes pin number to unexport', () => {
  const base = fakeBase();
  createGpio(base).unexportPin(17);
  assert.equal(fs.readFileSync(path.join(base, 'unexport'), 'utf8'), '17');
});

test('readPin returns 0/1 as number', () => {
  const base = fakeBase();
  makePin(base, 5, '1\n');
  assert.strictEqual(createGpio(base).readPin(5), 1);
});

test('invalid pins rejected before touching sysfs', () => {
  const g = createGpio(fakeBase());
  for (const bad of [-1, 1.5, '17; rm', NaN, undefined]) {
    assert.throws(() => g.exportPin(bad), /invalid pin/);
  }
});

test('exportPin error names pin and path', () => {
  const g = createGpio('/nonexistent-sysfs');
  assert.throws(() => g.exportPin(3), /pin 3.*\/nonexistent-sysfs\/export/);
});

test('exportPin treats EBUSY as already exported', () => {
  const base = fakeBase();
  const fsx = { ...fs, writeFileSync() { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
  assert.doesNotThrow(() => createGpio(base, fsx).exportPin(4));
});

test('watchPin sets direction/edge and fires callback on change; stop unwatches', async () => {
  const base = fakeBase();
  const d = makePin(base, 9, '0');
  const seen = [];
  const stop = createGpio(base).watchPin(9, 'in', 'both', (v) => seen.push(v));
  assert.equal(fs.readFileSync(path.join(d, 'direction'), 'utf8'), 'in');
  assert.equal(fs.readFileSync(path.join(d, 'edge'), 'utf8'), 'both');
  fs.writeFileSync(path.join(d, 'value'), '1');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(seen.includes(1));
  stop();
  assert.equal(fs.readFileSync(path.join(base, 'unexport'), 'utf8'), '9');
  const n = seen.length;
  fs.writeFileSync(path.join(d, 'value'), '0');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen.length, n);
});

test('writePin sets the pin as an output at the given level in one write (no glitch)', () => {
  const base = fakeBase();
  const d = makePin(base, 6);
  const g = createGpio(base);
  g.writePin(6, 1);
  assert.equal(fs.readFileSync(path.join(d, 'direction'), 'utf8'), 'high');
  g.writePin(6, 0);
  assert.equal(fs.readFileSync(path.join(d, 'direction'), 'utf8'), 'low');
  assert.throws(() => g.writePin(-1, 1), /invalid pin/);
});
