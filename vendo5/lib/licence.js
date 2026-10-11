const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

// The offline licence: everything enabled, never expires, no network, no signature check. The shape
// mirrors the fields the original frontend and handlers read from its licence object.
const FOREVER = 8640000000000000; // the largest Date value; "expiration" is compared with Date.now()

function createLicence({ stateDir, readFile = (f) => fs.readFileSync(f, 'utf8'), writeFile = fs.writeFileSync, randomHex = () => crypto.randomBytes(8).toString('hex') } = {}) {
  let cached = null;

  function deviceId() {
    if (cached) return cached;
    try {
      const m = /^Serial\s*:\s*([0-9a-fA-F]+)\s*$/m.exec(readFile('/proc/cpuinfo'));
      if (m && /[1-9a-fA-F]/.test(m[1])) return (cached = m[1].toLowerCase());
    } catch { /* no cpuinfo serial */ }
    try {
      const id = readFile('/etc/machine-id').trim();
      if (/^[0-9a-f]{16,}$/i.test(id)) return (cached = id.slice(0, 16).toLowerCase());
    } catch { /* no machine-id */ }
    const file = path.join(stateDir, 'device-id');
    try {
      const id = readFile(file).trim();
      if (/^[0-9a-f]{16}$/.test(id)) return (cached = id);
    } catch { /* first boot */ }
    const id = randomHex();
    fs.mkdirSync(stateDir, { recursive: true });
    writeFile(file, id + '\n', { mode: 0o600 });
    return (cached = id);
  }

  function licence() {
    return { serial: deviceId(), expiration: FOREVER, hotspot: 1000000, pppoe: 1000000, custom_theme: true, movie: true, checked: true };
  }

  return { deviceId, licence };
}

module.exports = { createLicence, FOREVER };
