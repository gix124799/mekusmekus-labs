const { jsonFile } = require('./jsonfile');

// Every sale, oldest first: { ts (ms), kind ('coin'|'voucher'|'credit'|'admin'), amount (pesos), mac, code?, owner?, note? }.
// Capped so flash cannot fill; the oldest records go first.
const MAX = 20000;

function createSales({ file, now = Date.now, onAdd = () => {} }) {
  const store = jsonFile(file, []);
  return {
    add(rec) {
      const all = store.read();
      all.push({ ts: now(), ...rec });
      store.write(all.length > MAX ? all.slice(all.length - MAX) : all);
      try { onAdd(all[all.length - 1]); } catch { /* a side effect must not undo the record */ }
    },
    all: () => store.read(),
    clear: () => store.write([]),
    // remove records for which keep(rec) is false
    filter(keep) {
      const all = store.read();
      const kept = all.filter(keep);
      if (kept.length !== all.length) store.write(kept);
      return all.length - kept.length;
    },
  };
}

module.exports = { createSales };
