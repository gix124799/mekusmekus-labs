const crypto = require('node:crypto');

const asObj = (v) => (v && typeof v === 'object' ? v : {});
const macOf = (item) => (typeof item === 'string' ? item : asObj(item).mac);

// Handlers for the admin shell, dashboard and logs pages (@nav-*). Each is (payload, ctx) => reply and
// every one is guarded: no logged-in session, no answer. Replies copy the shapes the original page reads.
function createNavHandlers({ sessions, firewall, arp, stats, passthrough, mainlog, notifications, licence, account, reset, now = Date.now, save = () => {} }) {
  const log = (text) => mainlog.write('system', text);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });

  // Active sessions in the three shapes @nav-89554 carries: data (per mac), session (per mac), pppoe (empty).
  function activeSessions() {
    const t = now();
    const neigh = arp.neighbors();
    const data = {};
    const session = {};
    for (const [mac, s] of Object.entries(sessions.all())) {
      const n = neigh[mac.toLowerCase()] || {};
      data[mac] = {
        type: s.type || 'consumable',
        duration: s.paused ? Math.round(s.remainingMs / 1000) : s.duration || Math.round((s.expiresAt - (s.startedAt || t)) / 1000),
        logindate: s.startedAt || t,
        expiration: s.expiresAt,
        uploadLimit: s.upload || 'Unlimited', // the page parses these as "<n><unit>" strings and tolerates any text
        downloadLimit: s.download || 'Unlimited',
        max_data_limit: s.max_data_limit || 0,
        total_upload_data: 0,
        total_download_data: 0,
      };
      session[mac] = { mac, address: n.ip || '', ifname: n.dev || '', brlan: n.dev || '', uptime: Math.max(0, Math.round((t - (s.startedAt || t)) / 1000)), idle: 0, upload: 0, download: 0, rx: 0, tx: 0 };
    }
    return { data, session, sessionList: {} };
  }

  // A row names its client by MAC, or (Vouchers page) by the code it is running.
  function resolveMac(x) {
    const m = macOf(x);
    if (typeof m === 'string' && !sessions.getSession(m)) {
      const s = Object.values(sessions.all()).find((v) => v.code === m);
      if (s) return s.mac;
    }
    return m;
  }

  // Removing a session: the firewall may never have heard of it (revoke then throws); the session goes either way.
  function remove(mac) {
    if (typeof mac !== 'string' || !mac) return false;
    try {
      firewall.revoke(mac);
    } catch {
      /* not in the allowed set: nothing to take away */
    }
    const had = sessions.revoke(mac);
    if (had) save();
    return had;
  }

  return {
    '@nav-89554': guarded({}, () => ({ ...stats.snapshot(), Watching: {}, now: now(), active: activeSessions(), pppoelist: { accounts: {}, active: {} } })),

    '@nav-23441': guarded({}, (payload) => passthrough(payload)),

    '@nav-232003': guarded({}, () => {
      const l = licence.licence();
      return { status: 'activated', code: l.serial, level: 'Unlimited', hotspot: l.hotspot, pppoe: l.pppoe, vendo: 'Yes', eload: 'Yes', movie: l.movie ? 'Yes' : 'No', serial: l.serial, expiration: l.expiration };
    }),
    '@nav-1452357': guarded('', () => Buffer.from(licence.licence().serial).toString('base64')),
    '@nav-14433223': guarded({}, () => ({ success: false, message: 'This device runs offline: no activation is needed' })),

    // Session actions. Every client row sends back the item it was drawn from ({mac, ...}).
    '@nav-89000': guarded('Error', (payload) => {
      const p = asObj(payload);
      const sess = sessions.extend(p.voucher, Number(p.duration) * 1000, now());
      if (!sess) return 'Error';
      save();
      log(`Admin extended ${p.voucher} by ${p.duration}s`);
      return 'Success';
    }),
    // vendo5 sessions cannot be paused, so there is nothing to disconnect without ending them.
    '@nav-22313': guarded('Error', () => 'Error'),
    '@nav-44232': guarded('Error', (payload) => {
      const mac = resolveMac(payload);
      if (!remove(mac)) return 'Error';
      log(`Admin removed session ${mac}`);
      return 'Success';
    }),
    '@nav-67345': guarded('Error', (payload) => {
      const info = Array.isArray(payload) ? payload : asObj(payload).info;
      const list = typeof info === 'string' ? [info] : info; // the Vouchers page removes one running voucher by its code
      if (!Array.isArray(list) || !list.length) return 'Error';
      let n = 0;
      for (const item of list) if (remove(resolveMac(item))) n++;
      if (n) log(`Admin removed ${n} session(s)`);
      return n ? 'Success' : 'Error';
    }),

    // Logs page.
    '@nav-645798': guarded([], () => mainlog.list()),
    '@nav-636547': guarded('', (name) => mainlog.read(name)),
    '@nav-362358': guarded({ success: false }, (name) => mainlog.remove(name)),
    '@nav-365478': guarded({}, (category) => {
      mainlog.removeByCategory(category);
      return {};
    }),

    // Notification bell.
    '@nav-63658987': guarded({}, () => notifications.list()),
    '@nav-3265892': guarded({}, (payload) => {
      notifications.markRead(asObj(payload).date);
      return {};
    }),
    '@nav-3654780': guarded({}, () => {
      notifications.clear();
      return {};
    }),

    // "Factory reset" in the profile menu: ends every session, restores the default login, clears notices.
    '@nav-3332145': guarded('Error', () => {
      for (const mac of Object.keys(sessions.all())) remove(mac);
      account.reset();
      notifications.clear();
      if (reset) reset();
      log('Admin reset the device');
      return 'Success';
    }),
  };
}

module.exports = { createNavHandlers };
