const { jsonFile } = require('./jsonfile');

const SPEED = /^\d+(K|M|G|T)$/;
const ID = /^[A-Za-z0-9_-]{1,32}$/;

// PPPoE subscribers and the billing customers attached to them.
//   accounts: { <username>: { username, password, amount, total_payment, upload, download, expiration (ms) } }
//   billing:  { <id>: { id, name, username, password, amount (n | [{date, amount}]), location, apikey, startdate (ms), paid: [{targetmonth, amount, date}] } }
function createPppoe({ file, now = Date.now }) {
  const store = jsonFile(file, { accounts: {}, billing: {} });
  const read = () => { const v = store.read(); return { accounts: v.accounts || {}, billing: v.billing || {} }; };
  const change = (fn) => { const s = read(); const r = fn(s); store.write(s); return r; };
  const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

  function cleanAccount(p) {
    const username = String(p.username || '');
    const password = String(p.password || '');
    if (!/^[A-Za-z0-9]{4,10}$/.test(username)) return { err: 'Username must be 4-10 letters or numbers' };
    if (!/^[A-Za-z0-9!@#$%^&*._-]{4,10}$/.test(password)) return { err: 'Password must be 4-10 characters' };
    if (!SPEED.test(String(p.upload)) || !SPEED.test(String(p.download))) return { err: 'Invalid speed limit' };
    const out = { username, password, upload: String(p.upload), download: String(p.download) };
    if (p.amount !== undefined && p.amount !== '') {
      const a = num(p.amount);
      if (!(a >= 0 && a <= 1e7)) return { err: 'Invalid amount' };
      out.amount = a;
    }
    return out;
  }

  return {
    now,
    list: () => read().accounts,
    get: (u) => (Object.hasOwn(read().accounts, u) ? read().accounts[u] : null),

    // The create form sends date + time; a date in the past would create an account that is already expired.
    create(p) {
      const a = cleanAccount(p);
      if (a.err) return a.err;
      const expiration = Date.parse(`${p.date} ${p.time}`);
      if (!Number.isFinite(expiration)) return 'Invalid expiration';
      if (expiration <= now()) return 'Expiration is in the past: Expired';
      return change((s) => {
        if (Object.hasOwn(s.accounts, a.username)) return 'Username already exists';
        s.accounts[a.username] = { ...a, total_payment: a.amount || 0, expiration };
        return 'Success';
      });
    },

    edit(p) {
      if (!p || typeof p !== 'object') return 'Error';
      const a = cleanAccount(p);
      if (a.err) return a.err;
      const expiration = Number(p.expiration);
      if (!Number.isFinite(expiration)) return 'Invalid expiration';
      return change((s) => {
        if (!Object.hasOwn(s.accounts, a.username)) return 'Username not found!';
        const old = s.accounts[a.username];
        s.accounts[a.username] = { ...old, ...a, expiration, amount: a.amount ?? old.amount };
        return 'Success';
      });
    },

    remove(usernames) {
      return change((s) => {
        let n = 0;
        for (const u of usernames) if (Object.hasOwn(s.accounts, u)) { delete s.accounts[u]; n++; }
        return n;
      });
    },

    // ---- billing customers
    billing: () => read().billing,
    billingAdd(p) {
      const name = String(p.name || '').trim();
      if (!name || name.length > 60 || !ID.test(String(p.id))) return { err: 'Invalid client' };
      const amount = num(p.amount);
      if (!(amount >= 0)) return { err: 'Invalid amount' };
      const startdate = Number(p.startdate);
      if (!Number.isFinite(startdate)) return { err: 'Invalid start date' };
      return change((s) => {
        if (Object.hasOwn(s.billing, p.id)) return { err: 'Duplicate id' };
        s.billing[p.id] = { id: p.id, name, username: String(p.username || '').slice(0, 10), password: String(p.password || '').slice(0, 10), amount, location: String(p.location || '').slice(0, 80), apikey: String(p.apikey || '').slice(0, 80), startdate, paid: [] };
        return {};
      });
    },
    billingEdit(id, fn) {
      return change((s) => {
        if (!Object.hasOwn(s.billing, id)) return { err: 'Client not found' };
        return fn(s.billing[id]) || {};
      });
    },
    billingRemove: (id) => change((s) => { if (!Object.hasOwn(s.billing, id)) return false; delete s.billing[id]; return true; }),
  };
}

module.exports = { createPppoe };
