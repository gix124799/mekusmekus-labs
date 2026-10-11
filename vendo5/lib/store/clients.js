const { jsonFile } = require('./jsonfile');

const noColons = (mac) => String(mac).toLowerCase().replace(/:/g, '');
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

// Everything the admin knows about a device, by MAC: { <mac>: { mac, name, credit (wallet pesos), point, total (pesos spent) } }.
function createClients({ file }) {
  const store = jsonFile(file, {});
  const rec = (all, mac) => (all[mac] = all[mac] || { mac, name: '', credit: 0, point: 0, total: 0 });
  const edit = (mac, fn) => {
    if (!MAC.test(String(mac))) return false;
    const m = String(mac).toLowerCase();
    const all = store.read();
    fn(rec(all, m));
    store.write(all);
    return true;
  };
  return {
    all: () => store.read(),
    list(extraMacs = []) {
      const all = store.read();
      for (const m of extraMacs) if (MAC.test(m)) rec(all, m.toLowerCase());
      return all;
    },
    addPoints: (mac, pts) => edit(mac, (r) => { r.point += pts; }),
    addTotal: (mac, pesos) => edit(mac, (r) => { r.total += pesos; }),
    setName: (mac, name) => typeof name === 'string' && name.length <= 40 && edit(mac, (r) => { r.name = name; }),
    setCredit: (mac, v) => Number.isFinite(v) && v >= 0 && edit(mac, (r) => { r.credit = v; }),
    setPoints: (mac, v) => Number.isFinite(v) && v >= 0 && edit(mac, (r) => { r.point = v; }),
    clearTotal: (mac) => edit(mac, (r) => { r.total = 0; }),
    remove(mac) {
      const all = store.read();
      const m = String(mac).toLowerCase();
      if (!Object.hasOwn(all, m)) return false;
      delete all[m];
      store.write(all);
      return true;
    },
    noColons,
  };
}

module.exports = { createClients, noColons, MAC };
