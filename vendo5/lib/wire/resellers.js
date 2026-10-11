const { md5, splitToken, CHALLENGE_WINDOW_MS } = require('./main');
const crypto = require('node:crypto');
const { perDay } = require('./sales');

const asObj = (v) => (v && typeof v === 'object' ? v : {});
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The admin's Reseller page (@nav-00112347): accounts, permissions, limits and the voucher/credit profiles.
function createResellerAdminHandlers({ resellers, mainlog }) {
  const log = (t) => mainlog.write('system', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });
  return {
    '@nav-00112347': guarded({ err: 'Error' }, (payload) => {
      const p = asObj(payload);
      const u = String(p.username || '').toLowerCase();
      switch (p.action) {
        case 'GET': return resellers.list();
        case 'ADD': {
          const r = resellers.add(p);
          if (!r) log(`Admin added the reseller ${u}`);
          return r || '';
        }
        case 'SET': { const r = resellers.setPassword(u, p.password); if (!r) log(`Admin changed the password of reseller ${u}`); return r || ''; }
        case 'REMOVE': { const ok = resellers.remove(u); if (ok) log(`Admin removed the reseller ${u}`); return ok ? '' : { err: 'Not found' }; }
        case 'PERMISSION': { const r = resellers.setPermission(u, p); if (!r) log(`Admin changed the permissions of reseller ${u}`); return r || ''; }
        case 'SET-P': return resellers.setProfile(u, p.H, p.H === 'credit' ? p.creditset : p.voucherset, p.type, p.oldProfile);
        default: return { err: 'Error' };
      }
    }),
  };
}

// The reseller portal (@sub-*): login, then their own vouchers, credit codes, tickets and sales, within their limits.
function createResellerPortalHandlers({ sessions, resellers, vouchers, credits, tickets, sales, licence, mainlog, version, now = Date.now, makeToken = () => crypto.randomBytes(16).toString('hex') }) {
  const log = (t) => mainlog.write('system', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });
  const me = (ctx) => (ctx.session && ctx.session.user ? resellers.get(ctx.session.user) : null);
  const can = (a, area, mode) => !!a && !!a.permission[area] && a.permission[area][mode] === true;
  const NO = { err: 'Not permitted' };
  const lines = (text, pick) => String(text).split('\n').filter((l) => { try { return pick(JSON.parse(l)); } catch { return false; } }).join('\n');

  return {
    '@sub-66322': { guard: false, fallback: {}, handler: () => ({ version, prefix: licence.deviceId().slice(0, 8) }) },

    // Same challenge/response as the admin login; the token request names the user.
    '@sub-48931': { guard: false, fallback: '', handler(username, ctx) {
      if (!ctx.session) return '';
      const token = makeToken();
      ctx.session.challenge = { token, at: now(), user: typeof username === 'string' ? username.toLowerCase().replace(/\s/g, '') : '' };
      return token;
    } },
    '@sub-66589': { guard: false, fallback: { login: false }, handler(payload, ctx) {
      const p = asObj(payload);
      const s = ctx.session;
      const ch = s && s.challenge;
      if (s) s.challenge = null;
      let ok = false;
      const acc = ch && resellers.get(ch.user);
      if (acc && now() - ch.at < CHALLENGE_WINDOW_MS) {
        const [a, b] = splitToken(ch.token);
        ok = safeEqual(p.username, md5(a + acc.username)) && safeEqual(p.password, md5(b + acc.password.replace(/\s/g, '')));
      }
      if (ok) { sessions.allow(s); s.user = acc.username; log(`Reseller Success Login: user ${acc.username} from ${ctx.ip}`); }
      else log(`Reseller Failed Login: user ${ch ? ch.user.slice(0, 16) : ''} from ${ctx.ip}`);
      return { login: ok };
    } },

    '@sub-889611': guarded('', (_p, ctx) => (me(ctx) || {}).username || ''),
    '@sub-889661': guarded({}, (_p, ctx) => { const a = me(ctx); if (!a) return {}; const { password, ...rest } = a; return rest; }),
    '@sub-84472': guarded('Error', (payload, ctx) => {
      const a = me(ctx);
      const p = asObj(payload);
      if (!a || p.oldtpass !== a.password) return 'Invalid Password';
      const r = resellers.setPassword(a.username, p.cnewpass);
      if (r) return r.err;
      log(`Reseller ${a.username} changed their password`);
      return 'Success';
    }),

    // Used vouchers / credit codes of this reseller, one JSON per line.
    '@sub-34400': guarded('', (payload, ctx) => {
      const a = me(ctx);
      const p = asObj(payload);
      if (!can(a, 'cvused', 'read')) return '';
      return p.type === 'credit' ? lines(credits.usedText(), (x) => x.name === a.username) : lines(vouchers.usedText(), (x) => x.genfrom === a.username);
    }),

    '@sub-234423': guarded({}, (_p, ctx) => {
      const a = me(ctx);
      if (!a) return {};
      const mine = (map, key) => Object.fromEntries(Object.entries(map).filter(([, v]) => v[key] === a.username));
      return { vouchers: can(a, 'vouchers', 'read') ? mine(vouchers.list(), 'genfrom') : {}, credits: can(a, 'credits', 'read') ? mine(credits.list(), 'name') : {} };
    }),

    // Generate only from a profile the admin gave this reseller (the form's values must match one), within the limit.
    '@sub-96547': guarded({ err: 'Error' }, (payload, ctx) => {
      const a = me(ctx);
      const p = asObj(payload);
      if (!can(a, 'vouchers', 'write')) return NO;
      const type = Number(p.type) === 1 ? 'pausable' : 'consumable';
      if (!a.vouchertype[type]) return { err: `${type} vouchers are not allowed` };
      const prof = Object.values(a.voucherset).find((s) => s.type === type && s.upload === p.upload && s.download === p.download && s.duration === Number(p.duration) && s.price === Number(p.price) && s.prefix === String(p.prefix || '').toUpperCase());
      if (!prof) return { err: 'This voucher setup is not allowed for your account' };
      const qty = Number(p.qty);
      if (!(Number.isInteger(qty) && qty >= 1 && qty <= 500)) return { err: 'Invalid quantity' };
      if (!resellers.use(a.username, 'voucher', qty)) return { err: 'Voucher limit reached' };
      const r = vouchers.generate({ ...p, random: true, owner: a.username, prefix: prof.prefix, length: prof.length, notsametype: prof.notsametype, max_data_limit: prof.max_data_limit, pauselimit: prof.pauselimit, validity: prof.validity });
      if (r.message !== 'Done') { resellers.release(a.username, 'voucher', qty); return { err: r.message }; }
      log(`Reseller ${a.username} generated ${r.newvoucher.length} voucher(s)`);
      return r;
    }),

    '@sub-52212': guarded({ err: 'Error' }, (payload, ctx) => {
      const a = me(ctx);
      if (!can(a, 'vouchers', 'write')) return NO;
      const mine = Object.keys(asObj(payload)).filter((c) => { const v = vouchers.get(c); return v && v.genfrom === a.username; });
      const n = vouchers.remove(mine);
      if (n) { resellers.release(a.username, 'voucher', n); log(`Reseller ${a.username} removed ${n} voucher(s)`); }
      return {};
    }),

    '@sub-36200': guarded({ err: 'Error' }, (payload, ctx) => {
      const a = me(ctx);
      const p = asObj(payload);
      if (!can(a, 'credits', 'write')) return NO;
      const prof = Object.values(a.creditset).find((s) => s.amount === Number(p.amount) && s.prefix === String(p.prefix || '').toUpperCase() && s.length === Number(p.length));
      if (!prof) return { err: 'This credit setup is not allowed for your account' };
      const quantity = Number(p.quantity);
      if (!(Number.isInteger(quantity) && quantity >= 1 && quantity <= 500)) return { err: 'Invalid quantity' };
      if (!resellers.use(a.username, 'credit', quantity)) return { err: 'Credit limit reached' };
      const r = credits.generate({ quantity, amount: prof.amount, prefix: prof.prefix, length: prof.length, name: a.username });
      if (r.error) { resellers.release(a.username, 'credit', quantity); return { err: r.error }; }
      log(`Reseller ${a.username} generated ${quantity} credit code(s)`);
      return r.codes;
    }),

    '@sub-35532': guarded({ err: 'Error' }, (payload, ctx) => {
      const a = me(ctx);
      if (!can(a, 'credits', 'write')) return NO;
      const mine = (Array.isArray(payload) ? payload.map(String) : []).filter((c) => { const v = credits.get(c); return v && v.name === a.username; });
      const n = credits.remove(mine);
      if (n) { resellers.release(a.username, 'credit', n); log(`Reseller ${a.username} removed ${n} credit code(s)`); }
      return {};
    }),

    // Tickets: the reseller's own only.
    '@sub-55685': guarded({}, (_p, ctx) => { const a = me(ctx); return can(a, 'ticket', 'read') ? tickets.list(a.username) : {}; }),
    '@sub-55699': guarded('', (name, ctx) => { const a = me(ctx); const t = can(a, 'ticket', 'read') ? tickets.get(name, a.username) : null; return t ? JSON.stringify(t) : ''; }),
    '@sub-29903': guarded('', (payload, ctx) => { const a = me(ctx); return can(a, 'ticket', 'write') ? tickets.save(asObj(payload), a.username) || '' : ''; }),
    '@sub-23466': guarded('Error', (name, ctx) => { const a = me(ctx); return can(a, 'ticket', 'write') && tickets.remove(name, a.username) ? 'Success' : 'Error'; }),

    // Their own sales per day (the admin keeps the books: a reseller cannot clear them).
    '@sub-0021145': guarded('Error', (payload, ctx) => {
      const a = me(ctx);
      if (!can(a, 'sales', 'read')) return 'Error';
      if (asObj(payload).action !== 'GET') return 'Error';
      const rows = sales.all();
      return { _vouchersales: { [a.username]: perDay(rows, (r) => r.kind === 'voucher' && r.owner === a.username) }, _creditsales: { [a.username]: perDay(rows, (r) => r.kind === 'credit' && r.owner === a.username) } };
    }),
  };
}

module.exports = { createResellerAdminHandlers, createResellerPortalHandlers };
