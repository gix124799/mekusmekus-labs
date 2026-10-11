const asObj = (v) => (v && typeof v === 'object' ? v : {});

// PPPoE Accounts and Billing pages, and the PPPoE rows of the dashboard.
function createPppoeHandlers({ store, system, mainlog, now = Date.now }) {
  const log = (t) => mainlog.write('system', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });

  // Billing figures the page computes itself; the server only stores customers and payments.
  return {
    '@nav-23442': guarded({ info: {}, now: 0 }, () => ({ now: now(), info: store.list() })),

    '@nav-32344': guarded('Error', (payload) => {
      const r = store.create(asObj(payload));
      if (r === 'Success') { system.sync(); log(`Admin created the PPPoE account ${asObj(payload).username}`); }
      return r;
    }),

    '@nav-89112': guarded('Error', (payload) => {
      const r = store.edit(payload);
      if (r === 'Success') { system.sync(); log(`Admin edited the PPPoE account ${asObj(payload).username}`); }
      return r;
    }),

    // Remove: the page sends {<username>: 1, ...}; 0 means done (the page tests == 0).
    '@nav-65698': guarded(1, (payload) => {
      const names = Object.keys(asObj(payload));
      if (!names.length) return 1;
      for (const u of names) system.disconnect(u);
      const n = store.remove(names);
      system.sync();
      if (n) log(`Admin removed ${n} PPPoE account(s)`);
      return n ? 0 : 1;
    }),

    '@nav-78663': guarded(false, (username) => {
      const n = system.disconnect(String(username));
      if (n) log(`Admin disconnected the PPPoE user ${username}`);
      return n > 0;
    }),

    // Server status for the Interfaces page: the pppd process is the supervisor's job, so report what the machine shows.
    '@nav-00782399': guarded({}, (payload) => {
      const act = system.active();
      return { stdout: act.length ? `running, ${act.length} online` : '' };
    }),

    '@nav-36582399': guarded({}, (payload) => {
      const p = asObj(payload);
      const num = Number(p.amount);
      switch (p.action) {
        case 'GET': return store.billing();
        case 'ADD': {
          const r = store.billingAdd(p);
          if (!r.err) log(`Admin added the billing client ${p.name}`);
          return r;
        }
        case 'REMOVE': return store.billingRemove(String(p.id)) ? {} : { err: 'Client not found' };
        case 'SETPPPoE': return store.billingEdit(String(p.id), (c) => { c.username = String(p.username || '').slice(0, 10); });
        case 'SETRATEAMOUNT':
          if (!(num >= 0)) return { err: 'Invalid amount' };
          return store.billingEdit(String(p.id), (c) => {
            if (p.date === undefined) { c.amount = num; return; }
            const t = Date.parse(p.date);
            if (!Number.isFinite(t)) return { err: 'Invalid date' };
            const history = Array.isArray(c.amount) ? c.amount : [{ date: c.startdate, amount: c.amount }];
            history.push({ date: p.date, amount: num });
            c.amount = history.slice(-60);
          });
        case 'ADDPAYMENT': {
          const pay = asObj(p.payment);
          if (!(Number(pay.amount) > 0) || typeof pay.targetmonth !== 'string' || pay.targetmonth.length > 20) return { err: 'Invalid payment' };
          return store.billingEdit(String(p.id), (c) => {
            if (c.paid.length >= 1200) return { err: 'Too many payments' };
            c.paid.push({ targetmonth: pay.targetmonth, amount: Number(pay.amount), date: now() });
          });
        }
        case 'SETPAYMENT':
          if (!Array.isArray(p.paid) || p.paid.length > 1200 || !p.paid.every((x) => x && typeof x === 'object' && Number(x.amount) > 0 && typeof x.targetmonth === 'string')) return { err: 'Invalid payment list' };
          return store.billingEdit(String(p.id), (c) => { c.paid = p.paid.map((x) => ({ targetmonth: x.targetmonth.slice(0, 20), amount: Number(x.amount), date: Number(x.date) || now() })); });
        default: return { err: 'Error' };
      }
    }),
  };
}

module.exports = { createPppoeHandlers };
