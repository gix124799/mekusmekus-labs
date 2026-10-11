const { jsonFile } = require('./jsonfile');
const { MAC } = require('./clients');

// Blocked and always-allowed devices: { blacklist: { <MAC>: name }, whitelist: { <MAC>: name } }, MACs upper-case.
function createAccess({ file }) {
  const store = jsonFile(file, { blacklist: {}, whitelist: {} });
  const read = () => {
    const v = store.read();
    return { blacklist: v.blacklist || {}, whitelist: v.whitelist || {} };
  };
  const up = (m) => String(m).toUpperCase().replace(/-/g, ':');
  return {
    get: read,
    isBlocked: (mac) => Object.hasOwn(read().blacklist, up(mac)),
    isWhitelisted: (mac) => Object.hasOwn(read().whitelist, up(mac)),
    add(list, mac, name) {
      if (!['blacklist', 'whitelist'].includes(list) || !MAC.test(up(mac)) || typeof name !== 'string' || !name || name.length > 40) return false;
      const v = read();
      const other = list === 'blacklist' ? 'whitelist' : 'blacklist';
      delete v[other][up(mac)]; // a device is on one list or the other
      v[list][up(mac)] = name;
      store.write(v);
      return true;
    },
    remove(list, mac) {
      if (!['blacklist', 'whitelist'].includes(list)) return false;
      const v = read();
      if (!Object.hasOwn(v[list], up(mac))) return false;
      delete v[list][up(mac)];
      store.write(v);
      return true;
    },
  };
}

module.exports = { createAccess };
