const asObj = (v) => (v && typeof v === 'object' ? v : {});
const SPEED = /^\d+(K|M|G|T)$/;

// Handlers for the Vouchers page and its ticket templates (@nav-*). Same conventions as nav.js: every one is
// guarded, takes (payload, ctx) and answers the shape the original page reads.
function createMoneyHandlers({ vouchers, tickets, sessions, mainlog, endSession, now = Date.now, save = () => {} }) {
  const log = (t) => mainlog.write('voucher', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });
  const byCode = (code) => Object.values(sessions.all()).find((s) => s.code === code);

  // Vouchers somebody is using right now (a session that came from a code).
  function activeVouchers() {
    const t = now();
    return Object.values(sessions.all())
      .filter((s) => s.code)
      .map((s) => {
        const e = {
          code: s.code, mac: s.mac, type: s.type || 'consumable', notsametype: s.notsametype ? 1 : 0,
          uploadLimit: s.upload || 'Unlimited', downloadLimit: s.download || 'Unlimited',
          lastactive: t, max_data_limit: s.max_data_limit, total_upload_data: 0, total_download_data: 0,
        };
        if (s.pauselimit !== undefined) e.pauselimit = s.pauselimit;
        if (s.validityEnd) e.validity = s.validityEnd;
        if (s.type === 'pausable') e.duration = Math.round((s.paused ? s.remainingMs : s.expiresAt - t) / 1000);
        else e.expiration = s.expiresAt;
        return e;
      });
  }

  return {
    '@nav-55647': guarded({}, () => vouchers.list()),
    '@nav-12215': guarded([], () => activeVouchers()),
    '@nav-536547': guarded('', () => vouchers.usedText()),
    '@nav-536548': guarded('Error', () => {
      vouchers.clearUsed();
      log('Admin cleared the used voucher list');
      return 'Success';
    }),

    '@nav-96547': guarded({ message: 'Error' }, (payload) => {
      const r = vouchers.generate(payload);
      if (r.message === 'Done') log(`Admin generated ${r.newvoucher.length} voucher(s) of ${r.newvoucher[0].duration}s for ${r.newvoucher[0].price} peso(s)`);
      return r;
    }),

    // "Remove": the page sends the selected vouchers keyed by code (or a list of codes).
    '@nav-52212': guarded({}, (payload) => {
      const codes = Array.isArray(payload) ? payload : Object.keys(asObj(payload));
      let n = vouchers.remove(codes.map(String));
      if (n) log(`Admin removed ${n} unused voucher(s)`);
      // the same dialog removes vouchers that are running: that ends the session they gave
      let ended = 0;
      for (const c of codes.map(String)) {
        const s = byCode(c);
        if (s) { endSession(s.mac); ended++; }
      }
      if (ended) { save(); log(`Admin removed ${ended} running voucher session(s)`); }
      return {};
    }),

    // Edit the limits (and a paused remainder) of the session a voucher is running.
    '@nav-43456': guarded({}, (payload) => {
      const p = asObj(payload);
      const s = (p.mac && sessions.getSession(String(p.mac))) || byCode(p.code);
      if (!s) return {};
      if (SPEED.test(String(p.uploadLimit))) s.upload = String(p.uploadLimit);
      if (SPEED.test(String(p.downloadLimit))) s.download = String(p.downloadLimit);
      if (Number.isInteger(p.pauselimit) && p.pauselimit >= 0 && s.type === 'pausable') s.pauselimit = p.pauselimit;
      if (s.paused && Number(p.duration) > 0) s.remainingMs = Number(p.duration) * 1000;
      save();
      log(`Admin edited ${s.code || s.mac}`);
      return {};
    }),

    // Add time to every selected active voucher.
    '@nav-43000': guarded({}, (payload) => {
      const p = asObj(payload);
      let n = 0;
      for (const code of Object.keys(asObj(p.list))) {
        const s = byCode(code);
        if (s && sessions.extend(s.mac, Number(p.duration) * 1000, now())) n++;
      }
      if (n) { save(); log(`Admin extended ${n} voucher session(s) by ${Number(p.duration)}s`); }
      return {};
    }),

    // Ticket templates (the print and Excel export of a generated batch).
    '@nav-55685': guarded({}, () => tickets.list()),
    '@nav-55699': guarded('', (name) => {
      const t = tickets.get(name);
      return t ? JSON.stringify(t) : '';
    }),
    '@nav-29903': guarded('', (payload) => tickets.save(asObj(payload)) || ''),
    '@nav-23466': guarded('Error', (name) => (tickets.remove(name) ? 'Success' : 'Error')),
  };
}

module.exports = { createMoneyHandlers };
