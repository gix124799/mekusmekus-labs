const asObj = (v) => (v && typeof v === 'object' ? v : {});
const pad = (n) => String(n).padStart(2, '0');
// The pages parse these keys with /\d{2}-\d{2}/ and /\d{4}$/.
const dayKey = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`; };

// Per-day totals of the sales records that pass `pick`: { "DD-MM-YYYY": pesos }.
function perDay(records, pick) {
  const out = {};
  for (const r of records) if (pick(r)) out[dayKey(r.ts)] = (out[dayKey(r.ts)] || 0) + r.amount;
  return out;
}

// Sales and VC Sales pages. deviceName labels the one machine's column; owners are voucher/credit batch names.
function createSalesHandlers({ sales, deviceName, mainlog }) {
  const log = (t) => mainlog.write('system', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });

  return {
    '@nav-00932': guarded({}, () => ({ [deviceName]: perDay(sales.all(), () => true) })),

    // Clear and Remove both drop the machine's sales inventory (there is only one machine).
    '@nav-11220': guarded({}, (payload) => {
      const p = asObj(payload);
      if ((p.clear || p.remove) && p.name === deviceName) {
        const n = sales.filter(() => false);
        log(`Admin ${p.clear ? 'cleared' : 'removed'} the sales inventory (${n} record(s))`);
      }
      return {};
    }),

    '@nav-0021145': guarded('Error', (payload) => {
      const p = asObj(payload);
      const rows = sales.all();
      const byOwner = (kind) => {
        const out = {};
        for (const owner of new Set(rows.filter((r) => r.kind === kind && r.owner).map((r) => r.owner))) out[owner] = perDay(rows, (r) => r.kind === kind && r.owner === owner);
        return out;
      };
      if (p.action === 'GET') return { _vouchersales: byOwner('voucher'), _creditsales: byOwner('credit') };
      const kind = p.type === '_vouchersales' ? 'voucher' : p.type === '_creditsales' ? 'credit' : null;
      if ((p.action === 'CLEAR' || p.action === 'REMOVE') && kind && typeof p.name === 'string') {
        const n = sales.filter((r) => !(r.kind === kind && r.owner === p.name));
        log(`Admin ${p.action === 'CLEAR' ? 'cleared' : 'removed'} ${kind} sales of ${p.name} (${n} record(s))`);
        return ''; // the page treats an empty reply as success
      }
      return 'Error';
    }),
  };
}

module.exports = { createSalesHandlers, dayKey, perDay };
