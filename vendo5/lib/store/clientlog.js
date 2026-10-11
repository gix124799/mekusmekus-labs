const fs = require('node:fs');
const path = require('node:path');
const { MAC, noColons } = require('./clients');

const MAX_LINES = 500;
const pad = (n) => String(n).padStart(2, '0');

// Per-device log, one file per MAC; lines "DD/MM/YYYY hh:mm:ss am|pm text" (the Devices page parses that).
function createClientLog({ dir, now = () => new Date() }) {
  const file = (key) => path.join(dir, `${key}.txt`);
  const keyOf = (k) => (/^[0-9a-f]{12}$/.test(k) ? k : MAC.test(k) ? noColons(k) : null);
  return {
    write(mac, text) {
      const key = keyOf(String(mac).toLowerCase());
      if (!key) return false;
      try {
        const d = now();
        const h = d.getHours();
        const line = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(h % 12 || 12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h < 12 ? 'am' : 'pm'} ${String(text).replace(/[\r\n]+/g, ' ')}`;
        fs.mkdirSync(dir, { recursive: true });
        let lines = [];
        try { lines = fs.readFileSync(file(key), 'utf8').split('\n').filter(Boolean); } catch { /* first line */ }
        fs.writeFileSync(file(key), [...lines, line].slice(-MAX_LINES).join('\n') + '\n');
        return true;
      } catch {
        return false; // logging never takes the app down
      }
    },
    read(k) {
      const key = keyOf(String(k).toLowerCase());
      if (!key) return { data: '' };
      try { return { data: fs.readFileSync(file(key), 'utf8') }; } catch { return { data: '' }; }
    },
    remove(k) {
      const key = keyOf(String(k).toLowerCase());
      if (!key) return { err: 'invalid id' };
      fs.rmSync(file(key), { force: true });
      return {};
    },
  };
}

module.exports = { createClientLog };
