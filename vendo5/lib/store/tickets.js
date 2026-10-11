const { jsonFile } = require('./jsonfile');

// Printable voucher tickets the admin saved: { "voucher-<ms>": { title, price, data: [row, ...] } }.
const NAME = /^voucher-\d+$/;
const MAX = 200;

function createTickets({ file, now = Date.now }) {
  const store = jsonFile(file, {});
  return {
    list: () => store.read(),
    get(name) {
      const all = store.read();
      return NAME.test(String(name)) && Object.hasOwn(all, name) ? all[name] : null;
    },
    save({ title, price, data }) {
      if (!Array.isArray(data) || data.length === 0 || data.length > 2000) return null;
      const all = store.read();
      const name = `voucher-${now()}`;
      all[name] = { title: String(title || '').slice(0, 60), price: Number(price) || 0, data };
      const names = Object.keys(all).sort();
      for (const n of names.slice(0, Math.max(0, names.length - MAX))) delete all[n];
      store.write(all);
      return name;
    },
    remove(name) {
      const all = store.read();
      if (!NAME.test(String(name)) || !Object.hasOwn(all, name)) return false;
      delete all[name];
      store.write(all);
      return true;
    },
  };
}

module.exports = { createTickets };
