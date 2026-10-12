const { cleanData } = require('./limits');
const LOCK_AFTER = 5;
const LOCK_MS = 5 * 60000;

// The one place a voucher, pause or resume turns into a session change, a firewall call, a sales
// record and a log line. A firewall failure undoes the session change; a voucher is only consumed
// once the client really has its time. (spec M4, M6)
function createMoney({ vouchers, credits, access, clientLog, ratePesosPerMinute = () => 1, sessions, firewall, sales, mainlog, save = () => {}, now = Date.now }) {
  const wrong = new Map(); // mac -> { count, until }
  const log = (t) => mainlog && mainlog.write('voucher', t);
  const clog = (mac, t) => clientLog && clientLog.write(mac, t);
  const blocked = (mac) => !!access && access.isBlocked(mac);

  const locked = (mac) => {
    const w = wrong.get(mac);
    return !!w && w.until > now();
  };
  function miss(mac) {
    const w = wrong.get(mac) || { count: 0, until: 0 };
    w.count += 1;
    if (w.count >= LOCK_AFTER) { w.until = now() + LOCK_MS; w.count = 0; }
    wrong.set(mac, w);
  }

  function redeemVoucher(mac, rawCode) {
    if (!mac) return { ok: false, message: 'Device not recognised' };
    if (blocked(mac)) return { ok: false, message: 'This device is blocked' };
    if (locked(mac)) return { ok: false, message: 'Too many wrong codes, try again in a few minutes' };
    const code = String(rawCode || '').trim().toUpperCase();
    const wellFormed = /^[A-Z0-9]{3,32}$/.test(code);
    const v = wellFormed ? vouchers.get(code) : null;
    if (!v && wellFormed && credits && credits.get(code)) return redeemCredit(mac, credits.get(code));
    if (!v) {
      miss(mac);
      log(`Invalid voucher ${code.slice(0, 32)} from ${mac}`);
      return { ok: false, message: 'Invalid voucher' };
    }
    const t = now();
    const cur = sessions.getSession(mac);
    const active = cur && (cur.paused || cur.expiresAt > t);
    if (active && cur.type !== v.type && !v.notsametype) return { ok: false, message: `This voucher cannot be added to a ${cur.type} session` };

    const before = cur ? structuredClone(cur) : null;
    sessions.addTime(mac, v.duration * 1000, { price: v.price, code: v.code, type: v.type, upload: v.upload, download: v.download, max_data_limit: v.max_data_limit, pauselimit: v.pauselimit, validityHours: v.validity, notsametype: v.notsametype }, t);
    const fresh = !before || (!before.paused && before.expiresAt <= t);
    if (fresh || !before.paused) {
      try {
        firewall.allow(mac);
      } catch (e) {
        sessions.restore(mac, before);
        log(`Firewall refused ${mac}: ${e.message}`);
        return { ok: false, message: 'Could not connect you, try again' };
      }
    }
    try {
      vouchers.remove([v.code]);
    } catch (e) {
      sessions.restore(mac, before);
      return { ok: false, message: 'Could not use the voucher, try again' };
    }
    try { vouchers.markUsed(v, mac); } catch (e) { log(`Used-voucher record failed: ${e.message}`); }
    try { sales.add({ kind: 'voucher', amount: v.price, mac, code: v.code, owner: v.genfrom }); } catch (e) { log(`Sales record failed: ${e.message}`); }
    save();
    log(`Voucher ${v.code} used by ${mac}: ${v.duration}s`);
    clog(mac, `Voucher ${v.code} used: ${v.duration}s`);
    wrong.delete(mac);
    return { ok: true, message: 'Success' };
  }

  // A credit code: pesos of time at the current rate, like coins, plus a sales record and the used list.
  function redeemCredit(mac, c) {
    const t = now();
    const before = sessions.getSession(mac) ? structuredClone(sessions.getSession(mac)) : null;
    const wasPaused = before && before.paused;
    sessions.addCredit(mac, c.amount, ratePesosPerMinute(), t);
    if (!wasPaused) {
      try {
        firewall.allow(mac);
      } catch (e) {
        sessions.restore(mac, before);
        log(`Firewall refused ${mac}: ${e.message}`);
        return { ok: false, message: 'Could not connect you, try again' };
      }
    }
    try {
      credits.remove([c.code]);
    } catch (e) {
      sessions.restore(mac, before);
      return { ok: false, message: 'Could not use the code, try again' };
    }
    try { credits.markUsed(c, mac); } catch (e) { log(`Used-credit record failed: ${e.message}`); }
    try { sales.add({ kind: 'credit', amount: c.amount, mac, code: c.code, owner: c.name }); } catch (e) { log(`Sales record failed: ${e.message}`); }
    save();
    log(`Credit code ${c.code} used by ${mac}: ${c.amount} peso(s)`);
    clog(mac, `Credit code ${c.code} used: ${c.amount} peso(s)`);
    wrong.delete(mac);
    return { ok: true, message: 'Success' };
  }

  function pause(mac, opts) {
    if (!mac) return { ok: false, message: 'Device not recognised' };
    const before = sessions.getSession(mac) ? structuredClone(sessions.getSession(mac)) : null;
    const r = sessions.pause(mac, now(), opts);
    if (!r.ok) return { ok: false, message: r.reason };
    try {
      firewall.revoke(mac);
    } catch (e) {
      sessions.restore(mac, before);
      return { ok: false, message: 'Could not pause, try again' };
    }
    save();
    log(`${mac} paused`);
    clog(mac, 'Paused');
    return { ok: true, message: 'Paused' };
  }

  function resume(mac) {
    if (!mac) return { ok: false, message: 'Device not recognised' };
    const before = sessions.getSession(mac) ? structuredClone(sessions.getSession(mac)) : null;
    const r = sessions.resume(mac, now());
    if (!r.ok) return { ok: false, message: r.reason };
    try {
      firewall.allow(mac);
    } catch (e) {
      sessions.restore(mac, before);
      return { ok: false, message: 'Could not resume, try again' };
    }
    save();
    log(`${mac} resumed`);
    clog(mac, 'Resumed');
    return { ok: true, message: 'Resumed' };
  }

  // Admin dashboard pause: any running session, no pause spent.
  const adminPause = (mac) => pause(mac, { force: true });

  // End a client's session for good (admin Remove): the firewall may never have known the MAC.
  function endSession(mac) {
    if (typeof mac !== 'string' || !mac) return false;
    try {
      firewall.revoke(mac);
    } catch {
      /* not in the allowed set (paused, or never allowed): nothing to take away */
    }
    const had = sessions.revoke(mac);
    if (had) save();
    return had;
  }

  // Admin "create custom session": free time for a MAC with the limits the form gave.
  function createSession(p) {
    const mac = String(p && p.mac || '').toLowerCase();
    const speed = /^\d+(K|M|G|T)$/;
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return { ok: false, message: 'Invalid MAC address' };
    if (!(Number.isInteger(p.duration) && p.duration > 0)) return { ok: false, message: 'Invalid duration' };
    if (!speed.test(String(p.upload)) || !speed.test(String(p.download))) return { ok: false, message: 'Invalid speed limit' };
    if (blocked(mac)) return { ok: false, message: 'This device is blocked' };
    const t = now();
    const before = sessions.getSession(mac) ? structuredClone(sessions.getSession(mac)) : null;
    const type = Number(p.type) === 1 ? 'pausable' : 'consumable';
    sessions.addTime(mac, p.duration * 1000, { type, upload: p.upload, download: p.download, max_data_limit: cleanData(p.max_data_limit), pauselimit: type === 'pausable' && p.pauselimit > 0 ? p.pauselimit : undefined, validityHours: type === 'pausable' ? p.validity : undefined }, t);
    if (!before || !before.paused) {
      try {
        firewall.allow(mac);
      } catch (e) {
        sessions.restore(mac, before);
        return { ok: false, message: 'Could not connect the device' };
      }
    }
    save();
    log(`Admin gave ${mac} a ${type} session of ${p.duration}s`);
    clog(mac, `Admin gave a session of ${p.duration}s`);
    return { ok: true, message: 'Success' };
  }

  return { redeemVoucher, pause, adminPause, resume, endSession, createSession, blocked };
}

module.exports = { createMoney, LOCK_AFTER, LOCK_MS };
