const asObj = (v) => (v && typeof v === 'object' ? v : {});
const MAC_IN = /([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/;

// Devices page: the client table and its row actions, block/white lists, per-device logs, free sessions.
function createDeviceHandlers({ clients, access, clientLog, sessions, money, firewall, mainlog, save = () => {} }) {
  const log = (t) => mainlog.write('system', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });
  const norm = (mac) => String(mac || '').toLowerCase().replace(/-/g, ':');

  return {
    // clientInfo is keyed by the MAC without colons (the page looks rows up that way); infos is per-MAC data use.
    '@nav-77833': guarded({}, () => {
      const info = {};
      for (const [mac, c] of Object.entries(clients.list(Object.keys(sessions.all())))) info[clients.noColons(mac)] = { mac, name: c.name, credit: c.credit, point: c.point, total: c.total };
      return { idbase: false, client: { clientInfo: info, infos: {} } };
    }),
    // The unique-id (cookie) mode is not used: no ids, nothing to clear.
    '@nav-113354': guarded({}, () => ({})),
    '@nav-113311': guarded({ success: false }, () => ({ success: false })),

    '@nav-33244': guarded('Error', (payload) => {
      const p = asObj(payload);
      const mac = norm(p.mac);
      switch (p.action) {
        case 'set-name': return clients.setName(mac, String(p.name)) ? (log(`Admin named ${mac} "${p.name}"`), 'Success') : 'Error';
        case 'set-credit': return clients.setCredit(mac, Number(p.newCredit)) ? (log(`Admin set the credit of ${mac} to ${p.newCredit}`), 'Success') : 'Error';
        case 'set-points': return clients.setPoints(mac, Number(p.points)) ? (log(`Admin set the points of ${mac} to ${p.points}`), 'Success') : 'Error';
        case 'total-credit-clear': return clients.clearTotal(mac) ? 'Success' : 'Error';
        case 'client-remove': {
          const m = norm(asObj(p.maclist).mac);
          if (!m) return 'Error';
          money.endSession(m);
          clients.remove(m);
          clientLog.remove(m);
          log(`Admin removed device ${m}`);
          return 'Success';
        }
        case 'get-cookie-info': return {};
        default: return 'Error';
      }
    }),

    '@nav-300214': guarded({ data: '' }, (key) => clientLog.read(key)),
    '@nav-30210': guarded({ err: 'Error' }, (key) => clientLog.remove(key)),

    '@nav-96549': guarded(false, (payload) => money.createSession(asObj(payload)).ok),

    // Block list and always-allowed list. Replies copy the page: add answers {fl, fwl}, remove answers 'Success'.
    '@nav-33254E': guarded('Error', (payload) => {
      const p = asObj(payload);
      const list = p.blacklist ? 'blacklist' : p.whitelist ? 'whitelist' : null;
      if (p.action === 'get') return access.get();
      if (!list) return 'Error';
      const m = MAC_IN.exec(String(p.mac || ''));
      if (!m) return 'Error';
      const mac = m[0].toUpperCase().replace(/-/g, ':');
      if (p.action === 'add') {
        if (!access.add(list, mac, p.name)) return 'Error';
        if (list === 'blacklist') {
          money.endSession(mac.toLowerCase());
        } else {
          try { firewall.allow(mac.toLowerCase()); } catch { /* the sync at boot retries */ }
        }
        log(`Admin added ${mac} to the ${list}`);
        return { fl: null, fwl: 0 };
      }
      if (p.action === 'remove') {
        if (!access.remove(list, mac)) return 'Error';
        if (list === 'whitelist' && !sessions.getSession(mac.toLowerCase())) {
          try { firewall.revoke(mac.toLowerCase()); } catch { /* it was not in the set */ }
        }
        log(`Admin removed ${mac} from the ${list}`);
        return 'Success';
      }
      return 'Error';
    }),
  };
}

module.exports = { createDeviceHandlers };
