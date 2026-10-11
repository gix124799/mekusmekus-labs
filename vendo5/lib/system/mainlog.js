const nodeFs = require('node:fs');
const path = require('node:path');

// "<category>-<DD>-<MM>-<YYYY>.txt": the format the Logs page parses (it strips "<category>-" and
// ".txt", then orders by year, month, day). Categories may contain hyphens ("phone-rental").
const FILE = /^([A-Za-z][A-Za-z-]*)-(\d{2})-(\d{2})-(\d{4})\.txt$/;
const CATEGORY = /^[A-Za-z][A-Za-z-]*$/;
const pad = (n) => String(n).padStart(2, '0');

function createMainLog({ dir, now = () => new Date(), maxPerCategory = 30, fs = nodeFs }) {
  const sortKey = (name) => {
    const m = FILE.exec(name);
    return m[4] + m[3] + m[2]; // YYYYMMDD
  };

  function listAll() {
    try {
      return fs.readdirSync(dir).filter((n) => FILE.test(n)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.localeCompare(b));
    } catch {
      return [];
    }
  }

  // One line per entry, newest appended last: "<hh:mm:ss am|pm>: <text>" (the page highlights the time).
  function write(category, text) {
    try {
      const cat = CATEGORY.test(category) ? category : 'system';
      const d = now();
      const h = d.getHours();
      const time = `${pad(h % 12 || 12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h < 12 ? 'am' : 'pm'}`;
      const file = `${cat}-${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}.txt`;
      fs.mkdirSync(dir, { recursive: true });
      // a log line is one line: never let the text forge another
      fs.appendFileSync(path.join(dir, file), `${time}: ${String(text).replace(/[\r\n]+/g, ' ')}\n`);
      const mine = listAll().filter((n) => FILE.exec(n)[1] === cat);
      for (const old of mine.slice(0, Math.max(0, mine.length - maxPerCategory))) fs.unlinkSync(path.join(dir, old)); // flash must not fill
      return true;
    } catch {
      return false; // logging never takes the app down (full or read-only disk)
    }
  }

  const list = () => listAll();

  function read(name) {
    if (typeof name !== 'string' || !FILE.test(name)) return '';
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return '';
    }
  }

  function remove(name) {
    if (typeof name !== 'string' || !FILE.test(name)) return { success: false, err: 'invalid file name' };
    try {
      fs.unlinkSync(path.join(dir, name));
      return { success: true };
    } catch (e) {
      return { success: false, err: e.message };
    }
  }

  function removeByCategory(category) {
    if (typeof category !== 'string' || !CATEGORY.test(category)) return { success: false, err: 'invalid category' };
    let removed = 0;
    for (const n of listAll()) {
      if (FILE.exec(n)[1] === category && remove(n).success) removed++;
    }
    return { success: true, removed };
  }

  return { write, list, read, remove, removeByCategory };
}

module.exports = { createMainLog, FILE };
