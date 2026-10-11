const { jsonFile } = require('./jsonfile');

// Printable voucher/credit tickets the admin saved: { "voucher-<ms>" | "credit-<ms>": { title, price, data: [row, ...] } }.
const NAME = /^(voucher|credit)-\d+$/;
const MAX = 200;

function createTickets({ file, now = Date.now }) {
  const store = jsonFile(file, {});
  return {
    // owner: a reseller sees only the tickets they saved; the admin (no owner) sees all
    list(owner) {
      const all = store.read();
      if (owner === undefined) return all;
      return Object.fromEntries(Object.entries(all).filter(([, t]) => t.owner === owner));
    },
    get(name, owner) {
      const all = store.read();
      if (!NAME.test(String(name)) || !Object.hasOwn(all, name)) return null;
      return owner === undefined || all[name].owner === owner ? all[name] : null;
    },
    save({ name: kind, title, price, data }, owner) {
      if (!Array.isArray(data) || data.length === 0 || data.length > 2000) return null;
      const all = store.read();
      const name = `${kind === 'credit' ? 'credit' : 'voucher'}-${now()}`;
      all[name] = { title: String(title || '').slice(0, 60), price: Number(price) || 0, data };
      if (owner !== undefined) all[name].owner = owner;
      const names = Object.keys(all).sort();
      for (const n of names.slice(0, Math.max(0, names.length - MAX))) delete all[n];
      store.write(all);
      return name;
    },
    remove(name, owner) {
      const all = store.read();
      if (!NAME.test(String(name)) || !Object.hasOwn(all, name)) return false;
      if (owner !== undefined && all[name].owner !== owner) return false;
      delete all[name];
      store.write(all);
      return true;
    },
  };
}

module.exports = { createTickets };
