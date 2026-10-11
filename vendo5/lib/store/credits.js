const crypto = require('node:crypto');
const { jsonFile, lineLog } = require('./jsonfile');
const { ALPHABET } = require('./vouchers');

const MAX_QTY = 500; // the page's own limit
const MAX_USED = 5000;

// Credit codes: { <code>: { amount (pesos), name, date (ms) } }. Redeeming one adds `amount` pesos of time
// at the current rate, exactly as if the coins had been inserted.
function createCredits({ file, usedFile = file.replace(/\.json$/, '') + '.used', now = Date.now, randomInt = (n) => crypto.randomInt(n) }) {
  const store = jsonFile(file, {});
  const used = lineLog(usedFile, MAX_USED);
  const int = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

  // p = { quantity, amount, prefix (0-5), length (6-8), name }. Answers the map of new codes, or {error}.
  function generate(p) {
    p = p && typeof p === 'object' ? p : {};
    const quantity = int(p.quantity);
    const amount = int(p.amount);
    const length = int(p.length);
    const prefix = String(p.prefix || '').toUpperCase();
    const name = String(p.name || '');
    if (!(Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QTY)) return { error: 'Invalid quantity' };
    if (!(Number.isInteger(amount) && amount >= 1 && amount <= 100000)) return { error: 'Invalid amount' };
    if (!(Number.isInteger(length) && length >= 6 && length <= 8)) return { error: 'Invalid length' };
    if (prefix.length > 5 || !/^[A-Z0-9]*$/.test(prefix)) return { error: 'Invalid prefix' };
    if (name.length < 3 || !/^[A-Za-z0-9]+$/.test(name)) return { error: 'Invalid name' };
    const all = store.read();
    const made = {};
    for (let i = 0; i < quantity; i++) {
      let code;
      let tries = 0;
      do {
        code = prefix;
        for (let k = 0; k < length; k++) code += ALPHABET[randomInt(ALPHABET.length)];
        if (++tries > 50) return { error: 'Could not find free codes' };
      } while (all[code] || made[code]);
      made[code] = { amount, name, date: now() };
    }
    store.write({ ...all, ...made });
    return { codes: made };
  }

  return {
    generate,
    list: () => store.read(),
    get(code) {
      const all = store.read();
      return Object.hasOwn(all, code) ? { code, ...all[code] } : null;
    },
    remove(codes) {
      const all = store.read();
      let n = 0;
      for (const c of codes) if (Object.hasOwn(all, c)) { delete all[c]; n++; }
      if (n) store.write(all);
      return n;
    },
    markUsed: (c, mac) => used.append({ ...c, mac, soldDate: now() }),
    usedText: used.text,
    clearUsed: used.clear,
  };
}

module.exports = { createCredits };
