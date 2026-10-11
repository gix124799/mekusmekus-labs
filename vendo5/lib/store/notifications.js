const fs = require('node:fs');
const path = require('node:path');

const MAX = 50;

// Bell-menu notices, {<epoch ms>: {title, icon, message, read}} in one JSON file; the page parses the key
// with parseInt() for the date and reads `message` for the body. Oldest are dropped past MAX.
function createNotifications({ file, now = () => new Date() }) {
  function load() {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  function save(all) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, file);
  }
  return {
    list: load,
    add({ title, icon = 'mdi-information-outline', message = '' }) {
      const all = load();
      all[String(now().getTime())] = { title: String(title), icon, message: String(message), read: false };
      const keys = Object.keys(all).sort((a, b) => Number(a) - Number(b));
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
      save(all);
    },
    markRead(date) {
      const all = load();
      if (!Object.hasOwn(all, date)) return false;
      all[date].read = true;
      save(all);
      return true;
    },
    clear: () => save({}),
  };
}

module.exports = { createNotifications };
