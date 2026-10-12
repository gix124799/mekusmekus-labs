// What the customer portal's buttons do beyond vouchers: free trial, disconnect/connect back, credit codes into the
// wallet, redeeming points, the spin wheel. Each returns what the original page reads (a status string or an object).
function createPortalOps({ sessions, firewall, clients, credits, sales, settings, access, mainlog, clientLog, save = () => {}, now = Date.now, random = Math.random, trialMaxPerHour = Infinity }) {
  const clog = (mac, t) => { if (clientLog) clientLog.write(mac, t); };
  const sys = (t) => { if (mainlog) mainlog.write('system', t); };
  const cfg = () => settings.read();
  const trials = []; // times of the trials given in the last hour (all devices)
  const live = (mac) => { const s = sessions.getSession(mac); return s && (s.paused || s.expiresAt > now()) ? s : null; };

  return {
    trial(mac, t) {
      if (clients.trialUsed(mac)) return 'You already used your free trial';
      if (access && access.isBlocked(mac)) return 'This device is blocked';
      if (live(mac)) return 'You are already connected';
      const ms = Math.round((Number(t.minutes) || 0) * 60000) || (Number(t.duration) || 0) * 1000;
      if (!(ms > 0)) return 'Free trial is not available';
      // Random MACs make the per-device trial flag easy to dodge, so the vendo as a whole has an hourly limit.
      // shortcut: counted in memory, a restart resets it; persist it if owners see abuse around reboots.
      while (trials.length && now() - trials[0] >= 3600000) trials.shift();
      if (trials.length >= trialMaxPerHour) return 'Free trial limit reached, try again later';
      const before = sessions.getSession(mac) ? structuredClone(sessions.getSession(mac)) : null;
      sessions.addTime(mac, ms, { price: 0, type: 'consumable', ...(t.upload ? { upload: t.upload } : {}), ...(t.download ? { download: t.download } : {}) }, now());
      try { firewall.allow(mac); } catch { sessions.restore(mac, before); return 'Could not connect you, try again'; }
      clients.markTrial(mac);
      trials.push(now());
      save();
      sys(`Free trial given to ${mac}`); clog(mac, 'Free trial');
      return 'Connected';
    },
    // "Disconnect" a running session: internet off, time keeps running (the original's consumable behaviour)
    disconnect(mac) {
      const s = live(mac);
      if (!s) return { ok: false, message: 'No active session' };
      try { firewall.revoke(mac); } catch { /* not in the allowed set */ }
      s.disconnected = true;
      save(); clog(mac, 'Disconnected');
      return { ok: true };
    },
    connectBack(mac) {
      const s = live(mac);
      if (!s) return { ok: false, message: 'No active session' };
      if (access && access.isBlocked(mac)) return { ok: false, message: 'This device is blocked' };
      if (!s.paused) { try { firewall.allow(mac); } catch { return { ok: false, message: 'Could not connect you, try again' }; } }
      delete s.disconnected;
      save(); clog(mac, 'Connected back');
      return { ok: true };
    },
    redeemCreditToWallet(mac, rawCode) {
      if (!mac) return 'Device not recognised';
      if (access && access.isBlocked(mac)) return 'This device is blocked';
      const code = String(rawCode || '').trim().toUpperCase();
      const c = /^[A-Z0-9]{3,32}$/.test(code) ? credits.get(code) : null;
      if (!c) return 'Invalid code';
      if (!clients.addCredit(mac, c.amount)) return 'Could not use the code, try again';
      try { credits.remove([c.code]); } catch { clients.addCredit(mac, -c.amount); return 'Could not use the code, try again'; }
      try { credits.markUsed(c, mac); } catch { /* record only */ }
      try { sales.add({ kind: 'credit', amount: c.amount, mac, code: c.code, owner: c.name }); } catch { /* record only */ }
      sys(`Credit code ${c.code} added ${c.amount} to ${mac}`); clog(mac, `Credit code ${c.code}: +${c.amount}`);
      return { amount: c.amount };
    },
    // Spend points on a redeem item the admin set up ({point: cost, credit: pesos given})
    redeemPoints(mac, id) {
      const item = mac && cfg().points.redeem[id];
      if (!item) return { error: true, message: 'Item not found' };
      const cost = Number(item.point || item.points || 0);
      const give = Number(item.credit || item.amount || 0);
      const have = (clients.all()[mac] || {}).point || 0;
      if (!(cost > 0) || !(give > 0)) return { error: true, message: 'Item not available' };
      if (have < cost) return { warning: true, message: 'Not enough points' };
      clients.setPoints(mac, Math.round((have - cost) * 100) / 100);
      clients.addCredit(mac, give);
      clog(mac, `Redeemed ${cost} point(s) for ${give} credit`);
      return { success: true, message: `You got ${give} credit` };
    },
    // One spin: costs `token` points, wins one of the wheel's segments
    spin(mac) {
      const w = cfg().points.spinwheel;
      if (!mac || w.display.length < 2) return { message: 'Spin wheel is not available' };
      const have = (clients.all()[mac] || {}).point || 0;
      if (have < (w.token || 0)) return { message: 'Not enough points' };
      const weights = w.display.map((_, i) => Math.max(0, Number((w.controller[i] || {}).chance ?? 1)));
      let r = random() * (weights.reduce((a, b) => a + b, 0) || 1), i = 0;
      while (i < weights.length - 1 && r >= weights[i]) { r -= weights[i]; i++; }
      const seg = w.display[i];
      const won = Number(seg.point || seg.points || (w.price[i] || {}).point || 0) || 0;
      clients.setPoints(mac, Math.round((have - (w.token || 0) + won) * 100) / 100);
      const step = 360 / w.display.length;
      clog(mac, `Spin: ${seg.name || ''} (${won} point(s))`);
      return { token: w.token || 0, points: won, angle: Math.round(step * i + step / 2), text: seg.name || '' };
    },
  };
}

module.exports = { createPortalOps };
