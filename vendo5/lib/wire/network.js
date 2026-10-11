const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const { jsonFile } = require('../store/jsonfile');
const { readLeases } = require('../system/leases');
const { isValidCron, isValidCrontab } = require('../system/cron');

const asObj = (v) => (v && typeof v === 'object' ? v : {});
const IPV4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)(\.|$)){4}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const ISP_MODES = ['single-isp', 'dual-isp-lbs', 'dual-isp-dsa'];

function defaults() {
  return { isp: {}, ispMode: '', pings: {}, netwatch: { ip: '', stoptimer: false }, walled: [], portfwd: {}, crontab: '' };
}

// Parse `iw phy` into { phy0: { phy, channels: { "band 1": [{channel}], "band 2": [...] } } } (enabled channels only).
function parseIwPhy(text) {
  const out = {};
  let phy = null;
  let band = null;
  for (const line of String(text).split('\n')) {
    let m = /^Wiphy (phy\d+)/.exec(line);
    if (m) { phy = out[m[1]] = { phy: m[1], channels: {} }; band = null; continue; }
    m = /^\s+Band (\d+):/.exec(line);
    if (m && phy) { band = `band ${m[1]}`; continue; }
    m = /^\s+\* \d+(?:\.\d+)? MHz \[(\d+)\]/.exec(line);
    if (m && phy && band && !/disabled|no IR|radar/.test(line)) (phy.channels[band] = phy.channels[band] || []).push({ channel: Number(m[1]) });
  }
  return out;
}

// Pages: Interfaces (ISP mode, speeds, pingers, WireGuard helpers), Leases, NTP, Scheduler, Utility (walled garden,
// netwatcher, ZeroTier), NFT (port forwarding), Wireless (channels). The uci-driven parts go through @nav-23441.
function createNetworkHandlers({ file, uci, runCommand, arp, mainlog, leasesFile, crontabFile, resolve4 = (h) => dns.promises.resolve4(h), now = Date.now, randomBytes = crypto.randomBytes }) {
  const store = jsonFile(file, defaults);
  const read = () => ({ ...defaults(), ...store.read() });
  const change = (fn) => { const s = read(); const r = fn(s); store.write(s); return r; };
  const log = (t) => mainlog.write('system', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });
  const tryRun = (argv) => { try { runCommand(argv); return true; } catch { return false; } };

  // ---- port forwarding: a table of its own, rebuilt from the saved list on every change
  function applyPortForward(map) {
    tryRun(['nft', 'add', 'table', 'ip', 'vendo5pf']);
    tryRun(['nft', 'delete', 'chain', 'ip', 'vendo5pf', 'prerouting']);
    if (!Object.keys(map).length) return true;
    if (!tryRun(['nft', 'add', 'chain', 'ip', 'vendo5pf', 'prerouting', '{', 'type', 'nat', 'hook', 'prerouting', 'priority', '-100', ';', '}'])) return false;
    for (const e of Object.values(map)) {
      const rule = ['nft', 'add', 'rule', 'ip', 'vendo5pf', 'prerouting'];
      if (e.srcip) rule.push('ip', 'daddr', e.srcip);
      rule.push('tcp', 'dport', String(e.srcport), 'dnat', 'to', `${e.dstip}:${e.dstport}`);
      if (!tryRun(rule)) return false;
    }
    return true;
  }

  function cleanForward(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 200) return null;
    const out = {};
    for (const [id, e] of Object.entries(map)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !e || typeof e !== 'object') return null;
      const sp = Number(e.srcport);
      const dp = Number(e.dstport);
      if (!(Number.isInteger(sp) && sp >= 1 && sp <= 65535 && Number.isInteger(dp) && dp >= 1 && dp <= 65535)) return null;
      if (!IPV4.test(String(e.dstip)) || (e.srcip && !IPV4.test(String(e.srcip)))) return null;
      out[id] = { srcip: e.srcip ? String(e.srcip) : '', srcport: String(sp), dstip: String(e.dstip), dstport: String(dp) };
      if (e.comment) out[id].comment = String(e.comment).slice(0, 60);
    }
    return out;
  }

  return {
    // ---- Interfaces page
    '@nav-0002311': guarded({}, (payload) => {
      const p = asObj(payload);
      if (!['isp1', 'isp2'].includes(p.type)) return {};
      if (p.action === 'set') {
        const d = Number(p.download);
        const u = Number(p.upload);
        if (!(d > 0 && u > 0)) return false;
        change((s) => { s.isp[p.type] = { download: d, upload: u }; });
        return true;
      }
      return read().isp[p.type] || {};
    }),
    '@nav-0002357': guarded(false, (payload) => {
      const p = asObj(payload);
      if (p.action === 'get') { const m = read().ispMode; return m ? [m] : false; }
      if (p.action === 'set') {
        if (!ISP_MODES.includes(p.mode)) return false;
        change((s) => { s.ispMode = p.mode; });
        log(`Admin set the WAN mode to ${p.mode}`);
        return true;
      }
      if (p.action === 'reload') { log('Admin reloaded the network'); return tryRun(['/etc/init.d/network', 'reload']) || true; }
      return false;
    }),
    '@nav-1442357': guarded(false, () => { log('Admin applied the WireGuard failover'); return true; }),
    '@nav-1452357': guarded('', () => {
      try {
        const k = String(runCommand(['wg', 'genkey'])).trim();
        if (/^[A-Za-z0-9+/]{43}=$/.test(k)) return k;
      } catch { /* no wg tool: make a valid key by hand */ }
      const b = randomBytes(32);
      b[0] &= 248; b[31] &= 127; b[31] |= 64; // the clamping `wg genkey` does
      return b.toString('base64');
    }),
    '@nav-1452399': guarded({}, (payload) => {
      const p = asObj(payload);
      if (p.action === 'GET') return read().pings;
      if (p.action === 'SET') {
        const pings = {};
        for (const k of ['ping1', 'ping2', 'ping3']) {
          if (p[k] === undefined || p[k] === '' || p[k] === null) continue;
          if (!IPV4.test(String(p[k]))) return false;
          pings[k] = String(p[k]);
        }
        change((s) => { s.pings = pings; });
        return true;
      }
      return {};
    }),
    '@nav-1452358': guarded({}, (payload) => {
      const p = asObj(payload);
      if (p.action === 'GET') return read().netwatch;
      if (p.action === 'SET') {
        if (!IPV4.test(String(p.ip))) return false;
        change((s) => { s.netwatch = { ip: String(p.ip), stoptimer: !!p.stoptimer }; });
        return true;
      }
      return false;
    }),
    '@nav-1000399': guarded(true, () => true), // static-IP rules are plain uci interfaces; the page just asks for a refresh

    // ---- Leases
    '@nav-99800': guarded({ cIfname: {}, date: 0 }, () => readLeases({ file: leasesFile, neighbors: () => arp.neighbors(), now })),

    // ---- NTP
    '@nav-78455': guarded({}, (payload) => {
      const p = asObj(payload);
      if (p.action === 'SET') {
        const list = Array.isArray(p.server) ? p.server : [];
        if (!list.length || list.length > 4 || !list.every((h) => typeof h === 'string' && HOST.test(h))) return {};
        uci.call('set', { config: 'system', section: 'ntp', values: { server: list } });
        uci.call('commit', { config: 'system' });
        log(`Admin set the NTP servers (${list.join(', ')})`);
        return {};
      }
      const v = uci.call('get', { config: 'system', section: 'ntp', option: 'server' }).value;
      return { date: now(), server: Array.isArray(v) ? v : v ? [v] : [] };
    }),

    // ---- Scheduler
    '@nav-365411145': guarded('', (payload) => {
      const p = asObj(payload);
      if (p.action === 'validate') return isValidCron(p.cron);
      if (p.action === 'SET') {
        if (!isValidCrontab(p.cron)) return 'Error';
        try {
          fs.mkdirSync(require('node:path').dirname(crontabFile), { recursive: true });
          fs.writeFileSync(crontabFile, p.cron);
        } catch { return 'Error'; }
        tryRun(['/etc/init.d/cron', 'restart']);
        log('Admin saved the scheduler');
        return '';
      }
      try { return fs.readFileSync(crontabFile, 'utf8'); } catch { return ''; }
    }),

    // ---- Utility: walled garden
    '@nav-3002145': guarded({ err: 'Error' }, async (payload) => {
      const p = asObj(payload);
      if (p.action === 'get') return read().walled;
      if (p.action === 'remove') {
        const had = read().walled.find((w) => w.id === p.id);
        if (!had) return { err: 'Not found' };
        for (const a of had.address) tryRun(['nft', 'delete', 'element', 'inet', 'vendo5', 'walled', '{', a, '}']);
        change((s) => { s.walled = s.walled.filter((w) => w.id !== p.id); });
        log(`Admin removed ${had.domain} from the walled garden`);
        return { success: true };
      }
      if (p.action === 'flush') {
        tryRun(['nft', 'flush', 'set', 'inet', 'vendo5', 'walled']);
        change((s) => { s.walled = []; });
        return { success: true };
      }
      if (p.action === 'add') {
        let host = String(p.domain || '').trim();
        try { host = new URL(/^[a-z]+:\/\//i.test(host) ? host : `http://${host}`).hostname; } catch { return { err: 'Invalid domain' }; }
        if (!HOST.test(host) || host.length > 253 || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(p.id) || read().walled.length >= 100) return { err: 'Invalid domain' };
        if (read().walled.some((w) => w.id === p.id)) return { err: 'Duplicate' };
        let address = [];
        if (IPV4.test(host)) address = [host];
        else { try { address = (await resolve4(host)).filter((a) => IPV4.test(a)).slice(0, 16); } catch { /* offline: kept without addresses, resolved when re-added */ } }
        for (const a of address) tryRun(['nft', 'add', 'element', 'inet', 'vendo5', 'walled', '{', a, '}']);
        change((s) => { s.walled.push({ id: p.id, domain: host, type: String(p.type || 'domain').slice(0, 10), address }); });
        log(`Admin added ${host} to the walled garden`);
        return { success: true };
      }
      return { err: 'Error' };
    }),

    // ---- NFT page: port forwards (GET answers the saved map as a JSON string)
    '@nav-326548': guarded('Error', (payload) => {
      const p = asObj(payload);
      if (p.action === 'GET') return JSON.stringify(read().portfwd);
      if (p.action === 'SET') {
        const map = cleanForward(p.config === undefined ? {} : p.config);
        if (!map) return 'Error';
        const ok = applyPortForward(map);
        change((s) => { s.portfwd = map; });
        log(`Admin saved ${Object.keys(map).length} port forward(s)`);
        return ok ? '' : 'Error';
      }
      return 'Error';
    }),

    // ---- Wireless: the channels each radio supports
    '@nav-23446': guarded({}, () => {
      let text = '';
      try { text = runCommand(['iw', 'phy']); } catch { /* no iw */ }
      let config = parseIwPhy(text);
      if (!Object.keys(config).length && uci.emulated) config = { phy0: { phy: 'phy0', channels: { 'band 1': Array.from({ length: 11 }, (_, i) => ({ channel: i + 1 })) } } };
      return { config };
    }),

    // ---- ZeroTier (a VPN the owner runs themselves) and the ngrok tunnel card (not used on this device)
    '@nav-23421': guarded({}, (payload) => {
      const p = asObj(payload);
      if (p.action === 'restart') { log('Admin restarted ZeroTier'); tryRun(['/etc/init.d/zerotier', 'restart']); return {}; }
      if (p.action === 'getinfo') {
        try { const v = JSON.parse(runCommand(['zerotier-cli', '-j', 'listnetworks'])); return Array.isArray(v) ? v : []; } catch { return []; }
      }
      return {};
    }),
    '@nav-63254': guarded({}, () => ({})),
    '@nav-23420': guarded({}, () => ({})),
    '@nav-11098': guarded({}, () => ({})),
    '@nav-23433': guarded('', () => ''),
    '@nav-262098': guarded({}, () => ({ info: 'Ngrok tunnels are not used on this device: it works offline.' })),
    '@nav-222098': guarded({}, () => ({ info: 'Ngrok tunnels are not used on this device: it works offline.' })),

  };
}

module.exports = { createNetworkHandlers, parseIwPhy };
