const { jsonFile } = require('./jsonfile');

const AREAS = ['vouchers', 'credits', 'cvused', 'sales', 'ticket'];
const SPEED = /^\d+(K|M|G|T)$/;
const PROFILE = /^[A-Za-z0-9 _-]{1,24}$/;

const bool = (v) => v === true;
const perm = (p) => {
  const out = {};
  for (const a of AREAS) out[a] = { read: bool(p && p[a] && p[a].read), write: bool(p && p[a] && p[a].write) };
  return out;
};
const limit = (l) => {
  const one = (x) => ({ l: Number.isInteger(x && x.l) && x.l > 0 ? x.l : 0, u: Number.isInteger(x && x.u) && x.u > 0 ? x.u : 0 });
  return { voucher: one(l && l.voucher), credit: one(l && l.credit) };
};

// Reseller accounts: { <username>: { username, password, limit: {voucher:{l,u}, credit:{l,u}} (l = 0: unlimited),
// permission: {vouchers|credits|cvused|sales|ticket: {read, write}}, vouchertype: {pausable, consumable},
// voucherset: { <profile>: {...what a Generate form fills} }, creditset: { <profile>: {profile, amount, prefix, length} } }.
function createResellers({ file }) {
  const store = jsonFile(file, {});
  const read = () => store.read();
  const change = (fn) => { const all = read(); const r = fn(all); store.write(all); return r; };
  const nameOk = (u) => /^[a-z0-9]{3,16}$/.test(u);

  function cleanVoucherSet(p) {
    const type = Number(p.type) === 1 ? 'pausable' : 'consumable';
    const duration = Number(p.duration);
    const length = Number(p.length);
    const price = Number(p.price);
    if (!PROFILE.test(String(p.profile))) return { err: 'Invalid profile name' };
    if (!SPEED.test(String(p.upload)) || !SPEED.test(String(p.download))) return { err: 'Invalid speed limit' };
    if (!(Number.isInteger(duration) && duration > 0) || !(Number.isInteger(length) && length >= 4 && length <= 16) || !(Number.isInteger(price) && price >= 0)) return { err: 'Invalid value' };
    const prefix = String(p.prefix || '').toUpperCase();
    if (!/^[A-Z0-9]*$/.test(prefix) || prefix.length > 8) return { err: 'Invalid prefix' };
    const out = { profile: String(p.profile), type, length, random: true, prefix, upload: String(p.upload), download: String(p.download), duration, price, notsametype: Number(p.notsametype) === 1 ? 1 : 0 };
    if (Number(p.max_data_limit) > 0) out.max_data_limit = Number(p.max_data_limit);
    if (type === 'pausable') { if (Number(p.pauselimit) > 0) out.pauselimit = Number(p.pauselimit); if (Number(p.validity) > 0) out.validity = Number(p.validity); }
    return out;
  }
  function cleanCreditSet(p, owner) {
    const amount = Number(p.amount);
    const length = Number(p.length);
    if (!PROFILE.test(String(p.profile))) return { err: 'Invalid profile name' };
    if (!(Number.isInteger(amount) && amount > 0 && amount <= 100000) || !(Number.isInteger(length) && length >= 6 && length <= 8)) return { err: 'Invalid value' };
    const prefix = String(p.prefix || '').toUpperCase();
    if (!/^[A-Z0-9]*$/.test(prefix) || prefix.length > 5) return { err: 'Invalid prefix' };
    return { profile: String(p.profile), amount, prefix, length, name: owner };
  }

  return {
    list: read,
    get: (u) => (Object.hasOwn(read(), u) ? read()[u] : null),

    add(p) {
      const username = String(p.username || '').toLowerCase();
      const password = String(p.password || '');
      if (!nameOk(username)) return { err: 'Username must be 3-16 letters or numbers' };
      if (password.length < 6 || password.length > 32 || /\s/.test(password)) return { err: 'Password must be 6-32 characters, no spaces' };
      return change((all) => {
        if (Object.hasOwn(all, username)) return { err: 'Username already exists' };
        all[username] = { username, password, limit: limit(p.limit), permission: perm(p.permission), vouchertype: { pausable: bool(p.vouchertype && p.vouchertype.pausable), consumable: bool(p.vouchertype && p.vouchertype.consumable) }, voucherset: {}, creditset: {} };
        return null;
      });
    },
    setPassword(u, password) {
      if (typeof password !== 'string' || password.length < 6 || password.length > 32 || /\s/.test(password)) return { err: 'Password must be 6-32 characters, no spaces' };
      return change((all) => { if (!Object.hasOwn(all, u)) return { err: 'Not found' }; all[u].password = password; return null; });
    },
    remove: (u) => change((all) => { if (!Object.hasOwn(all, u)) return false; delete all[u]; return true; }),
    setPermission(u, p) {
      return change((all) => {
        if (!Object.hasOwn(all, u)) return { err: 'Not found' };
        const a = all[u];
        a.permission = perm(p.permission);
        a.vouchertype = { pausable: bool(p.vouchertype && p.vouchertype.pausable), consumable: bool(p.vouchertype && p.vouchertype.consumable) };
        const l = limit(p.limit);
        a.limit = { voucher: { l: l.voucher.l, u: a.limit.voucher.u }, credit: { l: l.credit.l, u: a.limit.credit.u } }; // usage is not editable
        return null;
      });
    },
    // Voucher/credit profiles a reseller may generate from. type: add | edit | remove
    setProfile(u, kind, set, type, oldProfile) {
      return change((all) => {
        if (!Object.hasOwn(all, u)) return { err: 'Not found' };
        const key = kind === 'credit' ? 'creditset' : 'voucherset';
        const box = all[u][key];
        const s = set && typeof set === 'object' ? set : {};
        if (type === 'remove') { if (!Object.hasOwn(box, String(s.profile))) return { err: 'Profile not found' }; delete box[s.profile]; return { success: true }; }
        const clean = kind === 'credit' ? cleanCreditSet(s, u) : cleanVoucherSet(s);
        if (clean.err) return clean;
        if (type === 'add' && Object.hasOwn(box, clean.profile)) return { err: 'Profile already exists' };
        if (type === 'edit') { if (!Object.hasOwn(box, clean.profile)) return { err: 'Profile not found' }; }
        if (type !== 'add' && type !== 'edit') return { err: 'Error' };
        if (Object.keys(box).length >= 30 && type === 'add') return { err: 'Too many profiles' };
        box[clean.profile] = clean;
        return { success: true };
      });
    },
    // Count `n` newly generated codes against the limit; refuses (without counting) when it would pass the limit.
    use(u, kind, n) {
      return change((all) => {
        const l = all[u] && all[u].limit[kind];
        if (!l) return false;
        if (l.l > 0 && l.u + n > l.l) return false;
        l.u += n;
        return true;
      });
    },
    release(u, kind, n) {
      change((all) => { const l = all[u] && all[u].limit[kind]; if (l) l.u = Math.max(0, l.u - n); });
    },
  };
}

module.exports = { createResellers, AREAS };
