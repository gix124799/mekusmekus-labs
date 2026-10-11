const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSalesHandlers, dayKey } = require('../lib/wire/sales');
const { createSales } = require('../lib/store/sales');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5ws-'));
  let t = new Date(2026, 9, 11, 10, 0, 0).getTime();
  const sales = createSales({ file: path.join(dir, 's.json'), now: () => t });
  const lines = [];
  const h = createSalesHandlers({ sales, deviceName: 'ETHYLNET', mainlog: { write: (c, x) => lines.push(x) } });
  return { h, sales, lines, day: (n) => { t += n * 86400000; }, call: (id, p) => h[id].handler(p, {}) };
}

test('dayKey is DD-MM-YYYY in local time, the format the pages parse', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59).getTime()), '05-01-2026');
});

test('every sales event is guarded', () => {
  for (const [id, d] of Object.entries(rig().h)) assert.equal(d.guard, true, id);
});

test('Sales: per-day totals under the machine name, and clearing empties it', () => {
  const r = rig();
  r.sales.add({ kind: 'coin', amount: 1, mac: 'm1' });
  r.sales.add({ kind: 'voucher', amount: 5, mac: 'm1', owner: 'Juan' });
  r.day(1);
  r.sales.add({ kind: 'credit', amount: 10, mac: 'm2', owner: 'Pedro' });
  assert.deepEqual(r.call('@nav-00932'), { ETHYLNET: { '11-10-2026': 6, '12-10-2026': 10 } });
  r.call('@nav-11220', { name: 'Someone', clear: true });
  assert.equal(r.sales.all().length, 3, 'another name changes nothing');
  r.call('@nav-11220', { name: 'ETHYLNET', clear: true });
  assert.deepEqual(r.call('@nav-00932'), { ETHYLNET: {} });
  assert.match(r.lines[0], /cleared the sales inventory \(3 record/);
  assert.deepEqual(r.call('@nav-11220', null), {});
});

test('VC Sales: voucher and credit sales grouped by owner; CLEAR/REMOVE only that owner and kind', () => {
  const r = rig();
  r.sales.add({ kind: 'voucher', amount: 5, owner: 'Juan' });
  r.sales.add({ kind: 'voucher', amount: 5, owner: 'Juan' });
  r.sales.add({ kind: 'voucher', amount: 3, owner: 'Ana' });
  r.sales.add({ kind: 'credit', amount: 10, owner: 'Juan' });
  r.sales.add({ kind: 'coin', amount: 1 });
  assert.deepEqual(r.call('@nav-0021145', { action: 'GET' }), {
    _vouchersales: { Juan: { '11-10-2026': 10 }, Ana: { '11-10-2026': 3 } },
    _creditsales: { Juan: { '11-10-2026': 10 } },
  });
  assert.equal(r.call('@nav-0021145', { action: 'CLEAR', type: '_vouchersales', name: 'Juan' }), '');
  assert.deepEqual(Object.keys(r.call('@nav-0021145', { action: 'GET' })._vouchersales), ['Ana']);
  assert.equal(r.sales.all().filter((x) => x.kind === 'credit').length, 1, 'credit sales of the same owner stay');
  assert.equal(r.call('@nav-0021145', { action: 'REMOVE', type: '_creditsales', name: 'Juan' }), '');
  assert.equal(r.sales.all().length, 2);
  for (const bad of [null, {}, { action: 'NUKE' }, { action: 'CLEAR', type: 'x', name: 'Juan' }, { action: 'CLEAR', type: '_vouchersales', name: 5 }]) assert.equal(r.call('@nav-0021145', bad), 'Error', JSON.stringify(bad));
});
