const { timeForPesos, profileFor } = require('./rates');

// The client's wallet ("credit"): coins inserted in the portal's coin popup and redeemed credit codes land here, and
// the portal turns wallet pesos into internet time at the rate table (Connect / Extend). All of it by MAC.
function createWallet({ clients, sessions, firewall, settings, ratePesosPerMinute, access, mainlog, clientLog, save = () => {}, now = Date.now }) {
  const log = (m, t) => { if (mainlog) mainlog.write('system', t); if (clientLog) clientLog.write(m, t); };
  const mainCfg = () => settings.read().main;

  return {
    balance: (mac) => clients.credit(mac),
    add: (mac, pesos) => clients.addCredit(mac, pesos),
    // Spend `pesos` of wallet: a new session, or more time on a running one. Undone completely if the firewall refuses.
    connect(mac, pesos) {
      if (!mac) return { ok: false, message: 'Device not recognised' };
      if (access && access.isBlocked(mac)) return { ok: false, message: 'This device is blocked' };
      if (!(pesos > 0)) return { ok: false, message: 'Insufficient Credit' };
      if (!(clients.credit(mac) >= pesos)) return { ok: false, message: 'Insufficient Credit' };
      const cfg = mainCfg().config;
      const ms = timeForPesos(cfg, pesos, ratePesosPerMinute());
      if (!(ms > 0)) return { ok: false, message: 'Error: no rate' };
      const t = now();
      const before = sessions.getSession(mac) ? structuredClone(sessions.getSession(mac)) : null;
      const fresh = !before || (!before.paused && before.expiresAt <= t);
      sessions.addTime(mac, ms, { price: pesos, ...(fresh ? profileFor(cfg, pesos) : {}) }, t);
      const s = sessions.getSession(mac);
      delete s.disconnected;
      if (!(before && before.paused)) {
        try {
          firewall.allow(mac);
        } catch (e) {
          sessions.restore(mac, before);
          return { ok: false, message: 'Could not connect you, try again' };
        }
      }
      clients.addCredit(mac, -pesos);
      save();
      log(mac, `Connected with ${pesos} peso(s) of credit (${Math.round(ms / 1000)}s)`);
      return { ok: true, message: before && !fresh ? 'Success' : 'Connected', ms };
    },
  };
}

module.exports = { createWallet };
