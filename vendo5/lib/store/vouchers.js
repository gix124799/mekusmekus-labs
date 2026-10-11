const crypto = require('node:crypto');
const { jsonFile } = require('./jsonfile');

// No 0/1/I/L/O: a code read off a printed ticket must not be ambiguous. 31 symbols.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_QTY = 2000; // the page's own limit
const SPEED = /^\d+(K|M|G|T)$/;
const WORD = /^[A-Za-z0-9]*$/;

function randomCode(length, randomInt) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

// Unused voucher codes: { <code>: { code, duration (s), upload, download, type, notsametype, genfrom,
// price, pauselimit?, max_data_limit?, validity? (hours), created (ms) } }.
function createVouchers({ file, now = Date.now, randomInt = (n) => crypto.randomInt(n) }) {
  const store = jsonFile(file, {});
  const toInt = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

  // p is the Generate form as the page sends it. Answers {message, newvoucher?} like the original.
  function generate(p) {
    p = p && typeof p === 'object' ? p : {};
    const qty = toInt(p.qty);
    const duration = toInt(p.duration);
    const price = toInt(p.price);
    const random = p.random !== false && p.random !== 'false';
    const prefix = String(p.prefix || '').toUpperCase();
    const custom = String(p.custom || '').toUpperCase();
    const length = random ? toInt(p.length) : 0;
    if (random && !(qty >= 1 && qty <= MAX_QTY && Number.isInteger(qty))) return { message: 'Invalid quantity' };
    if (!WORD.test(prefix)) return { message: 'Invalid prefix' };
    if (random && !(Number.isInteger(length) && length >= 4 && length <= 16)) return { message: 'Invalid code length' };
    if (!random && !/^[A-Z0-9]{5,8}$/.test(custom)) return { message: 'Invalid custom voucher' };
    if (!(Number.isInteger(duration) && duration > 0)) return { message: 'Invalid duration' };
    if (!(Number.isInteger(price) && price >= 0)) return { message: 'Invalid price' };
    if (!SPEED.test(String(p.upload)) || !SPEED.test(String(p.download))) return { message: 'Invalid speed limit' };
    const owner = String(p.owner || '');
    if (owner.length < 3 || !/^[A-Za-z0-9]+$/.test(owner)) return { message: 'Invalid name' };

    const all = store.read();
    const type = Number(p.type) === 1 ? 'pausable' : 'consumable';
    const made = [];
    const n = random ? qty : 1;
    for (let i = 0; i < n; i++) {
      let code = custom;
      if (!random) {
        if (all[code]) return { message: 'Voucher code already exists' };
      } else {
        let tries = 0;
        do {
          code = prefix + randomCode(length, randomInt);
          if (++tries > 50) return { message: 'Could not find free codes, use a longer code' };
        } while (all[code] || made.some((v) => v.code === code));
      }
      const v = { code, duration, upload: String(p.upload), download: String(p.download), type, notsametype: Number(p.notsametype) === 1 ? 1 : 0, genfrom: owner, price, created: now() };
      if (Number(p.max_data_limit) > 0) v.max_data_limit = Number(p.max_data_limit);
      if (type === 'pausable') {
        if (Number(p.pauselimit) > 0) v.pauselimit = Number(p.pauselimit);
        if (Number(p.validity) > 0) v.validity = Number(p.validity);
      }
      made.push(v);
    }
    for (const v of made) all[v.code] = v;
    store.write(all);
    return { message: 'Done', newvoucher: made, now: now() };
  }

  return {
    generate,
    list: () => store.read(),
    get: (code) => {
      const all = store.read();
      return Object.hasOwn(all, code) ? all[code] : null;
    },
    // Edit what an unused voucher grants (the admin's edit dialog).
    update(code, patch) {
      const all = store.read();
      if (!Object.hasOwn(all, code)) return false;
      for (const k of ['duration', 'upload', 'download']) if (patch[k] !== undefined) all[code][k] = patch[k];
      store.write(all);
      return true;
    },
    remove(codes) {
      const all = store.read();
      let n = 0;
      for (const c of codes) if (Object.hasOwn(all, c)) { delete all[c]; n++; }
      if (n) store.write(all);
      return n;
    },
  };
}

module.exports = { createVouchers, ALPHABET };
