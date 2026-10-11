const fs = require('node:fs');
const path = require('node:path');
const { log } = require('../logger');

// One JSON document on disk, written atomically (temp file + rename). A missing file is the fallback;
// a corrupt one is the fallback too, logged once, never an exception into a handler.
function jsonFile(file, fallback) {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') log('error', 'unreadable data file, starting empty', { file, error: e.message });
        return typeof fallback === 'function' ? fallback() : structuredClone(fallback);
      }
    },
    write(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, file);
    },
  };
}

// An append-style log of JSON objects, one per line, newest last, capped at `max` lines (oldest first out).
function lineLog(file, max) {
  const lines = () => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    append(obj) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [...lines(), JSON.stringify(obj)].slice(-max).join('\n') + '\n');
    },
    text: () => lines().join('\n'),
    clear: () => fs.rmSync(file, { force: true }),
  };
}

module.exports = { jsonFile, lineLog };
