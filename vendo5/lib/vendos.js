// The vendos: "main" (this machine's own coin slot) and the sub-vendos (ESP8266 coin boxes, one VLAN each),
// kept in settings.sub. Requests (an ESP that knows the vendo key but is not accepted yet) and who polled
// lately are in memory: a restart only asks the ESPs to poll again.
const ONLINE_MS = 10000;

function createVendos({ settings, now = Date.now }) {
  const requests = new Map(); // chip -> { id: chip, name, mac, iface, ip, at }
  const seenAt = new Map(); // vendo id -> { at, version, interface }
  const subs = () => settings.read().sub || {};
  const editSub = (id, fn) => settings.change((s) => (s.sub && s.sub[id] ? (fn(s.sub[id], s), true) : false));

  return {
    get: (id) => (id === 'main' ? { ...settings.read().main, id: 'main' } : subs()[id] || null),
    byChip: (chip) => Object.values(subs()).find((v) => v.chip === chip) || null,
    forIface(dev) {
      const v = dev ? Object.values(subs()).find((x) => x.iface === dev) : null;
      return v ? v.id : 'main';
    },
    request(chip, { mac = '', iface = '', ip = '' } = {}) {
      const r = requests.get(chip) || { id: chip, name: `SubVendo-${chip}`, at: now() };
      requests.set(chip, { ...r, mac, iface, ip });
    },
    requests: () => [...requests.values()],
    accept(chip) {
      const r = requests.get(chip);
      if (!r) return null;
      const id = settings.change((s) => {
        s.sub = s.sub || {};
        let n = 1;
        while (s.sub[`sub${n}`]) n += 1;
        const nid = `sub${n}`;
        s.sub[nid] = { id: nid, chip, name: `Sub Vendo ${n}`, description: '', mac: r.mac, iface: r.iface, countdownMax: s.main.countdownMax, coinsBlockerDelay: s.main.coinsBlockerDelay, activated: true, license: 'Offline', lastdate: now(), message: '' };
        return nid;
      });
      requests.delete(chip);
      return id;
    },
    remove(id) {
      if (id === 'main') return false;
      const ok = settings.change((s) => (s.sub && s.sub[id] ? (delete s.sub[id], true) : false));
      seenAt.delete(id);
      return ok;
    },
    rename: (id, name) => editSub(id, (v) => { v.name = name; }),
    describe: (id, description) => editSub(id, (v) => { v.description = description; }),
    setCountdown: (id, seconds) => editSub(id, (v) => { v.countdownMax = seconds; }),
    setIface: (id, iface) => editSub(id, (v) => { v.iface = iface; }),
    seen(id, { version = '', interface: iface = '' } = {}) { seenAt.set(id, { at: now(), version, interface: iface }); },
    isOnline(id) {
      if (id === 'main') return true;
      const x = seenAt.get(id);
      return !!x && now() - x.at <= ONLINE_MS;
    },
    online() {
      const out = {};
      for (const [id, x] of seenAt) if (now() - x.at <= ONLINE_MS) out[id] = { version: x.version, interface: x.interface };
      return out;
    },
  };
}

module.exports = { createVendos };
