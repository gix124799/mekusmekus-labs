const LEVELS = ['debug', 'info', 'warn', 'error'];

function log(level, message, fields = {}, out = process.stdout) {
  if (!LEVELS.includes(level)) throw new Error(`unknown log level: ${level}`);
  out.write(JSON.stringify({ ...fields, ts: new Date().toISOString(), level, message }) + '\n');
}

module.exports = { log, LEVELS };
