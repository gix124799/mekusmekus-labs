const LEVELS = ['debug', 'info', 'warn', 'error'];
const CAPACITY = 500;
const recent = []; // module-level ring buffer; same singleton pattern as lib/config.js's `loaded`

function log(level, message, fields = {}, out = process.stdout) {
  if (!LEVELS.includes(level)) throw new Error(`unknown log level: ${level}`);
  const entry = { ...fields, ts: new Date().toISOString(), level, message };
  out.write(JSON.stringify(entry) + '\n');
  recent.push(entry);
  if (recent.length > CAPACITY) recent.shift();
}

function getRecent() {
  return recent.slice();
}

module.exports = { log, getRecent, LEVELS };
