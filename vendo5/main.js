const path = require('node:path');
const clientIp = require('./lib/client-ip');
const { loadConfig } = require('./lib/config');
const { log } = require('./lib/logger');
const { createGpio } = require('./lib/gpio');
const { createSessionStore } = require('./lib/session');
const { createFirewall } = require('./lib/firewall');
const { createArp } = require('./lib/arp');
const { createServer } = require('./lib/portal');
const { createStatic } = require('./lib/ui/static');
const { createPages } = require('./lib/ui/pages');
const { createAdminRoutes } = require('./lib/ui/admin-routes');
const { createAccountStore } = require('./lib/store/account');
const { createNotifications } = require('./lib/store/notifications');
const { createLicence } = require('./lib/licence');
const { createMainLog } = require('./lib/system/mainlog');
const { createStats } = require('./lib/system/stats');
const { createWatchdog } = require('./lib/system/watchdog');
const { createCoinGuard } = require('./lib/coinguard');
const { createVendos } = require('./lib/vendos');
const { createSubvendoApi } = require('./lib/subvendo');
const { RESUME_SCRIPT } = require('./lib/ui/resume-script');
const { createSessions } = require('./lib/wire/session');
const { createMainHandlers } = require('./lib/wire/main');
const { createNavHandlers } = require('./lib/wire/nav');
const { createMoneyHandlers } = require('./lib/wire/money');
const { createSalesHandlers } = require('./lib/wire/sales');
const { createDeviceHandlers } = require('./lib/wire/devices');
const { createSettingsHandlers } = require('./lib/wire/settings');
const { createSettings } = require('./lib/store/settings');
const { createSystemHandlers } = require('./lib/wire/system');
const { timeForPesos, profileFor } = require('./lib/money/rates');
const { createUci } = require('./lib/system/uci');
const { createNetworkHandlers } = require('./lib/wire/network');
const { createPppoeHandlers } = require('./lib/wire/pppoe');
const { createResellers } = require('./lib/store/resellers');
const { createResellerAdminHandlers, createResellerPortalHandlers } = require('./lib/wire/resellers');
const { createResellerRoutes } = require('./lib/ui/reseller-routes');
const { createFileHandlers } = require('./lib/wire/files');
const { createChatHandlers, clientSend } = require('./lib/wire/chat');
const { createEloadHandlers } = require('./lib/wire/eload');
const { createOfflinePageHandlers } = require('./lib/wire/offline-pages');
const { createChat } = require('./lib/store/chat');
const { createPortalPages, defaultHide } = require('./lib/ui/portal-pages');
const { createPortalHandlers, KEYS: PORTAL_KEYS } = require('./lib/wire/portal');
const { attachPortal } = require('./lib/wire/portal-server');
const { createThemeResolver } = require('./lib/wire/portal-v2');
const { createPortalOps } = require('./lib/money/portal-ops');
const { createShaper } = require('./lib/system/shaper');
const { createWallet } = require('./lib/money/wallet');
const { createFileArea } = require('./lib/system/files');
const { createMediaHandlers } = require('./lib/wire/media');
const { createMedia, partitionsFromLsblk } = require('./lib/store/media');
const { createPppoe } = require('./lib/store/pppoe');
const { createPppoeSystem } = require('./lib/system/pppoe');
const { createNetCommands } = require('./lib/system/netcmd');
const { createClients } = require('./lib/store/clients');
const { createAccess } = require('./lib/store/access');
const { createClientLog } = require('./lib/store/clientlog');
const { createVouchers } = require('./lib/store/vouchers');
const { createTickets } = require('./lib/store/tickets');
const { createCredits } = require('./lib/store/credits');
const { createSales } = require('./lib/store/sales');
const { createMoney } = require('./lib/money/redeem');
const { createPassthrough } = require('./lib/wire/passthrough');
const { attachWire } = require('./lib/wire/server');
const { version } = require('./package.json');

const configDir = process.env.VENDO5_CONFIG_DIR || '/mnt/wifi5/vendo5-config';
const defaultsDir = process.env.VENDO5_DEFAULTS_DIR || '/opt/vendo5/config';
const sessionFile = process.env.VENDO5_SESSION_FILE || '/mnt/wifi5/vendo5-sessions.json';
const gpioBase = process.env.VENDO5_GPIO_BASE || '/sys/class/gpio';
const uiDir = process.env.VENDO5_UI_DIR || '/opt/vendo5/ui';
const stateDir = process.env.VENDO5_STATE_DIR || '/mnt/wifi5/vendo5';
const deviceName = process.env.VENDO5_DEVICE_NAME || 'ETHYLNET';
const portalPort = Number(process.env.VENDO5_PORTAL_PORT || 3000);

let config;
try {
  config = loadConfig(configDir, defaultsDir);
} catch (e) {
  log('error', e.message);
  process.exit(1);
}

const shutdown = () => { log('info', 'vendo5 stopping'); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

log('info', 'vendo5 started', { version, config: Object.keys(config) });

const { coin_pin, relay_pin = 11, relay_pin_active = 1, pulse_value_pesos, pesos_per_minute } = config.vendo;

// After a pin change the machine restarts to use the new pins. Only under a supervisor (procd respawns it);
// a bare `node main.js` keeps running and picks the pins up next time it is started.
const restart = () => { if (process.env.VENDO5_SUPERVISED === '1') setTimeout(() => { log('info', 'vendo5 restarting for new settings'); process.exit(0); }, 800); };

const session = createSessionStore(sessionFile);
session.load();
const notifications = createNotifications({ file: path.join(stateDir, 'notification.json') });

// shortcut: no-op shell-out for firewall/arp when VENDO5_FIREWALL_CMD=noop
// (used by the smoke test, which has no real nft/ip environment). Real
// deployments never set this, so production always shells out for real.
// The one exception is read-only `ip -j ...`, which the network pages need to show a development machine's real
// interfaces; nothing else (nft, reboot, ...) runs.
const realRun = (args, opts = {}) => {
  const { execFileSync } = require('node:child_process');
  // a hung command must not freeze the event loop for long; unpacking an update is the one slow job (opts.timeout)
  return execFileSync(args[0], args.slice(1), { encoding: 'utf8', timeout: opts.timeout || 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); // a failing command's stderr goes into the error, not the system log
};
const runCommand = process.env.VENDO5_FIREWALL_CMD === 'noop'
  ? (args, opts) => (args[0] === 'ip' && args[1] === '-j' ? realRun(args, opts) : '')
  : realRun;

const firewall = createFirewall(runCommand);
// shortcut: VENDO5_ARP_FAKE_MAC fixes every client's resolved MAC, for
// tests that need a deterministic payer without a real LAN/ARP table.
// Real deployments never set this.
const arp = process.env.VENDO5_ARP_FAKE_MAC
  ? { ipToMac: () => process.env.VENDO5_ARP_FAKE_MAC, neighbors: () => ({}) }
  : createArp(runCommand);

try {
  // a paused session is deliberately not let through
  firewall.syncFromSessions(Object.fromEntries(Object.entries(session.all()).filter(([, v]) => !v.paused)));
} catch (e) {
  log('error', 'firewall sync failed at boot', { error: e.message });
}

// The admin page needs a writable state dir and the UI files. Without them the captive portal must
// still sell time, so a failure here is logged and /admin simply is not served.
let admin = null;
try {
  const account = createAccountStore(path.join(stateDir, 'account.json'));
  if (account.load()) log('warn', 'admin login created with the factory default; change it from the admin page');
  const licence = createLicence({ stateDir });
  const mainlog = createMainLog({ dir: path.join(stateDir, 'mainlogs') });
  const sessions = createSessions({});
  const pages = createPages({ root: uiDir, version, hostname: deviceName,
    // development only: scripts/probe.py injects a recorder that logs every reply property the page reads
    headScript: process.env.VENDO5_PROBE_JS ? `<script>${require('node:fs').readFileSync(process.env.VENDO5_PROBE_JS, 'utf8')}</script>` : '' });
  const appDir = __dirname;
  // Installing software replaces this very directory, so it is only allowed on the device (under its supervisor).
  const updateEnabled = process.env.VENDO5_SUPERVISED === '1';
  const fileArea = createFileArea({ root: path.join(stateDir, 'pppoe-html') });
  const adminRoutes = createAdminRoutes({ pages, sessions, files: fileArea, serveStatic: createStatic({ root: uiDir }), system: { stateDir, version, restart, mainlog, appDir, runCommand, updateEnabled } });
  // OpenWrt has ubus; a development machine does not, and then the same pages run against an emulated uci.
  const hasUbus = process.env.VENDO5_FIREWALL_CMD !== 'noop' && ['/bin/ubus', '/sbin/ubus', '/usr/bin/ubus', '/usr/sbin/ubus'].some((f) => require('node:fs').existsSync(f));
  const stats = createStats({ runCommand, standIns: hasUbus ? [] : ['eth0', 'eth1'] });
  const uci = createUci({ runCommand, stateFile: path.join(stateDir, 'uci-emulated.json'), hasUbus });
  const net = createNetCommands({ runCommand, uci });
  const pppoeStore = createPppoe({ file: path.join(stateDir, 'pppoe.json') });
  const pppoeSystem = createPppoeSystem({ store: pppoeStore, secretsFile: process.env.VENDO5_PPP_SECRETS || (hasUbus ? '/etc/ppp/chap-secrets' : path.join(stateDir, 'ppp', 'chap-secrets')), limitsDir: path.join(stateDir, 'ppp', 'limits'), sessionsDir: process.env.VENDO5_PPP_SESSIONS || '/var/run/vendo5/ppp', runCommand });
  try { pppoeSystem.sync(); } catch (e) { log('error', 'could not write the PPPoE secrets', { error: e.message }); }
  setInterval(() => { try { pppoeSystem.sweep(); } catch (e) { log('error', 'PPPoE sweep failed', { error: e.message }); } }, 60000).unref();
  if (!hasUbus) log('warn', 'no ubus on this machine: the network pages use an emulated uci');
  const vouchers = createVouchers({ file: path.join(stateDir, 'vouchers', 'list.json') });
  const tickets = createTickets({ file: path.join(stateDir, 'vouchers', 'tickets.json') });
  const credits = createCredits({ file: path.join(stateDir, 'credits', 'list.json') });
  const settings = createSettings({ file: path.join(stateDir, 'settings.json'), deviceName, coinPin: coin_pin, relayPin: relay_pin, relayPinActive: relay_pin_active });
  const vendos = createVendos({ settings });
  const clients = createClients({ file: path.join(stateDir, 'clients.json') });
  const access = createAccess({ file: path.join(stateDir, 'access.json') });
  const clientLog = createClientLog({ dir: path.join(stateDir, 'userlogs') });
  // devices on the always-allowed list stay through a restart (the firewall sync above flushed them)
  for (const mac of Object.keys(access.get().whitelist)) { try { firewall.allow(mac.toLowerCase()); } catch (e) { log('error', 'whitelist allow failed', { mac, error: e.message }); } }
  const sales = createSales({ file: path.join(stateDir, 'sales.json'), onAdd: (r) => {
    if (!r.mac) return;
    clients.addTotal(r.mac, r.amount);
    // points earned for a coin / voucher / credit of exactly this value (the Point System rules)
    const rule = settings.read().points[{ coin: 'vendo', voucher: 'voucher', credit: 'credit' }[r.kind]];
    const hit = Array.isArray(rule) && rule.find((x) => x.coin === r.amount);
    if (hit) clients.addPoints(r.mac, hit.point);
  } });
  const money = createMoney({ vouchers, credits, access, clientLog, ratePesosPerMinute: () => pesos_per_minute, sessions: session, firewall, sales, mainlog, save: () => session.save() });
  // Media: the disks lsblk shows mounted under /mnt on the device; on a development machine, one folder stands in.
  const mediaDir = path.join(stateDir, 'media-disk');
  const partitions = hasUbus
    ? () => { try { return partitionsFromLsblk(runCommand(['lsblk', '-J', '-b', '-o', 'NAME,LABEL,MOUNTPOINT,SIZE,VENDOR,MODEL'])); } catch { return []; } }
    : () => { require('node:fs').mkdirSync(mediaDir, { recursive: true }); return [{ name: 'sda1', mountpoint: mediaDir, fssize: 8 * 1024 ** 3, label: 'MEDIA', info: { vendor: 'Development', model: 'Folder' } }]; };
  const media = createMedia({ partitions, stateFile: path.join(stateDir, 'media.json') });
  const chat = createChat({ dir: path.join(stateDir, 'chat') });
  let pushToAdmins = () => {}; // set once the socket server exists
  const push = (ev, payload) => pushToAdmins(ev, payload);
  const events = {
    ...createChatHandlers({ chat, clients, online: () => new Set(Object.entries(session.all()).filter(([m]) => session.isActive(m)).map(([m]) => m)), push, mainlog }),
    ...createEloadHandlers({ file: path.join(stateDir, 'eload.json'), mainlog }),
    ...createOfflinePageHandlers({ file: path.join(stateDir, 'offline-pages.json'), mainlog }),
    ...createMediaHandlers({ media, mainlog }),
    ...createFileHandlers({ area: fileArea, mainlog }),
    ...createPppoeHandlers({ store: pppoeStore, system: pppoeSystem, mainlog }),
    ...createNetworkHandlers({ file: path.join(stateDir, 'network.json'), uci, runCommand, arp, mainlog, leasesFile: process.env.VENDO5_LEASES_FILE || (hasUbus ? '/mnt/wifi5/dhcp.leases' : '/tmp/dhcp.leases'), crontabFile: process.env.VENDO5_CRONTAB || (hasUbus ? '/etc/crontabs/root' : path.join(stateDir, 'crontab')) }),
    ...createSystemHandlers({ appDir, runCommand, mainlog, restart, enabled: updateEnabled }),
    ...createSettingsHandlers({ settings, vendos, mainlog, deviceName, restart, version, lanInterface: config.network.lan_interface }),
    ...createDeviceHandlers({ clients, access, clientLog, sessions: session, money, firewall, mainlog, save: () => session.save() }),
    ...createSalesHandlers({ sales, deviceName, mainlog }),
    ...createMoneyHandlers({ vouchers, credits, tickets, sessions: session, mainlog, endSession: money.endSession, save: () => session.save() }),
    ...createMainHandlers({ account, sessions, licence, mainlog, version }),
    ...createNavHandlers({
      pppoe: { store: pppoeStore, system: pppoeSystem },
      sessions: session,
      firewall,
      money,
      arp,
      stats,
      passthrough: createPassthrough({ runCommand, reboot: () => runCommand(['reboot']), systemInfo: stats.systemInfo, net }),
      mainlog,
      notifications,
      licence,
      account,
      save: () => session.save(),
    }),
  };
  const hooks = { stopCoin: () => {}, listenCoin: () => ({ ok: false, message: 'Not ready' }), pushTo: () => {} }; // set once the sockets exist
  const ops = createPortalOps({ sessions: session, firewall, clients, credits, sales, settings, access, mainlog, clientLog, save: () => session.save(), trialMaxPerHour: Number(config.vendo.trial_max_per_hour ?? 10) });
  const wallet = createWallet({ clients, sessions: session, firewall, settings, ratePesosPerMinute: () => pesos_per_minute, access, mainlog, clientLog, save: () => session.save() });
  const portalPages = createPortalPages({ root: uiDir, version, hostname: deviceName, keys: PORTAL_KEYS, hide: () => ({}),
    theme: () => settings.read().portalTheme.set || 'defualt-theme', redirect: () => settings.read().redirect, custom: () => { const t = settings.read().portalTheme; return t.enable ? t.script : ''; },
    headScript: (process.env.VENDO5_PROBE_JS ? `<script>${require('node:fs').readFileSync(process.env.VENDO5_PROBE_JS, 'utf8')}</script>` : '') + RESUME_SCRIPT });
  const portalEvents = createPortalHandlers({ sessions: session, money, ops, wallet, clients, settings, clientLog, chat: { clientHasUnread: (m) => chat.clientHasUnread(m), markClientSeen: (m) => chat.markClientSeen(m), history: (m) => chat.history(m), send: (m, t) => clientSend({ chat, push }, m, t) }, media, vouchers, arp, version,
    listenCoin: (mac, socket) => hooks.listenCoin(mac, socket), stopCoin: (mac) => hooks.stopCoin(mac), ratePesosPerMinute: () => pesos_per_minute, vendoOf: (mac) => vendoOf(mac) });
  const themeResolver = createThemeResolver({ log, handlers: { handshake: { fallback: {}, handler: () => ({ footer: settings.read().footer, hostname: deviceName.toUpperCase(), version, redirect: String(settings.read().redirect || ''), options: { ...defaultHide(), defaulttheme: false }, customTheme: '', ioKey: PORTAL_KEYS, redirecturl: '' }) } } });
  const resellers = createResellers({ file: path.join(stateDir, 'resellers.json') });
  const resellerSessions = createSessions({});
  const resellerRoutes = createResellerRoutes({ root: uiDir, version, hostname: deviceName, sessions: resellerSessions, resellers });
  const resellerEvents = createResellerPortalHandlers({ sessions: resellerSessions, resellers, vouchers, credits, tickets, sales, licence, mainlog, version });
  events['@nav-00112347'] = createResellerAdminHandlers({ resellers, mainlog })['@nav-00112347'];
  const routes = (req, res) => resellerRoutes(req, res) || adminRoutes(req, res);
  admin = { themeResolver, portalPages, portalEvents, hooks, wallet, sessionsStore: session, serveStatic: createStatic({ root: uiDir }), chatApi: { history: (m) => chat.history(m), send: (m, t) => clientSend({ chat, push }, m, t), seen: (m) => chat.markClientSeen(m) }, setPush: (f) => { pushToAdmins = f; }, routes, events, sessions, resellerEvents, resellerSessions, mainlog, money, sales, access, clientLog, settings, vendos };
} catch (e) {
  log('error', 'admin page unavailable; the portal runs without it', { error: e.message });
}

// Which vendo a phone is at: the interface it is seen on (br-lan = main, a sub-vendo's VLAN = that sub-vendo).
function vendoOf(mac) { return admin && mac ? admin.vendos.forIface((arp.neighbors()[String(mac).toLowerCase()] || {}).dev) : 'main'; }

let subApi = null; // the sub-vendo poll handler, created after the admin block (needs admin.vendos et al)
const { server, consumePendingPayer, setPendingPayer, hasPendingPayer, releasePendingPayer } = createServer({ session, arp, ratePesosPerMinute: pesos_per_minute, adminRoutes: admin && admin.routes, money: admin && admin.money, chat: admin && admin.chatApi,
  portal: admin && { render: (p) => admin.portalPages.render(p), themeDir: () => admin.portalPages.themeDir(), serveStatic: admin.serveStatic },
  subvendo: admin && ((b, ip) => { const mac = arp.ipToMac(ip); const dev = mac ? (arp.neighbors()[mac.toLowerCase()] || {}).dev : ''; return subApi.handle(b, { iface: dev || '', ip, mac: mac || '' }); }) });
const inserts = new Map(); // mac -> { timer, vendo }: devices with the portal's coin popup open
// Coin acceptor power (relay pin from Pin Setup): on while a coin popup is open and the slot is not locked,
// off coinsBlockerDelay ms after the last popup closes so a coin already falling is still counted. The physical
// relay is main's; a sub-vendo's acceptor relay is switched by its own ESP from the poll reply.
let coinRelay = () => {}; // set once the gpio is up and a relay pin is configured
const guards = new Map(); // vendo id -> coin guard; main's is made with the GPIO, sub-vendos' on first use
let makeGuard = null; // (vendo) => guard, set with the coin handler below
const guardOf = (vendo) => { if (!guards.has(vendo) && makeGuard) guards.set(vendo, makeGuard(vendo)); return guards.get(vendo); };
const coinLocked = (vendo = 'main') => { const g = guards.get(vendo); return !!g && g.isLocked(); };
const coinsBlockerDelayOf = (vendo) => { const v = admin && admin.vendos.get(vendo); return v ? Number(v.coinsBlockerDelay) || 0 : 0; };
const hasMainInsert = () => [...inserts.values()].some((x) => x.vendo === 'main');
let relayOffTimer = null;
const openCoinSlot = () => { clearTimeout(relayOffTimer); if (!coinLocked('main')) coinRelay(true); };
const closeCoinSlotSoon = () => {
  clearTimeout(relayOffTimer);
  relayOffTimer = setTimeout(() => { if (!hasMainInsert()) coinRelay(false); }, coinsBlockerDelayOf('main'));
};
const endInsert = (mac, io) => { const i = inserts.get(mac); if (!i) return; clearTimeout(i.timer); inserts.delete(mac); releasePendingPayer(mac, Date.now(), coinsBlockerDelayOf(i.vendo), i.vendo); if (!hasMainInsert()) closeCoinSlotSoon(); io.pushTo(mac, PORTAL_KEYS[21], { done: true, countdown: 0, countdownMax: 0, type: 'info', message: '' }); };
if (admin) {
  const adminIo = attachWire(server, { events: admin.events, sessions: admin.sessions, log });
  admin.setPush((ev, payload) => adminIo.pushAuthed(ev, payload));
  const portalIo = attachPortal(server, { events: admin.portalEvents, identify: (sock) => arp.ipToMac(clientIp(sock.handshake.address, sock.handshake.headers)), log, ...admin.themeResolver });
  const waitMsFor = (vendo) => (Number((admin.vendos.get(vendo) || {}).countdownMax) || admin.settings.read().main.countdownMax) * 1000;
  const armInsert = (mac, vendo = (inserts.get(mac) || {}).vendo || 'main', wait = waitMsFor(vendo)) => {
    const old = inserts.get(mac);
    if (old) clearTimeout(old.timer);
    inserts.set(mac, { timer: setTimeout(() => endInsert(mac, portalIo), wait), vendo });
    return wait;
  };
  admin.hooks.listenCoin = (mac) => {
    if (admin.money.blocked(mac)) return { ok: false, message: 'This device is blocked' };
    const vendo = vendoOf(mac);
    if (!admin.vendos.isOnline(vendo)) return { ok: false, message: 'Vendo is offline' };
    if (coinLocked(vendo)) return { ok: false, message: 'Coin slot is temporarily locked, try again in a few minutes' };
    const wait = waitMsFor(vendo);
    if (!setPendingPayer(mac, Date.now(), wait + 2000, vendo)) return { ok: false, message: 'Vendo is busy, someone else is inserting coins' };
    armInsert(mac, vendo, wait);
    if (vendo === 'main') openCoinSlot();
    return { ok: true, countdown: wait / 1000, expiry: Date.now() + wait };
  };
  admin.hooks.stopCoin = (mac) => endInsert(mac, portalIo);
  // a coin while the popup is open goes to the device's wallet (the Done/Connect button turns it into time)
  admin.portalCoin = (mac, pesos, vendo = 'main') => {
    if (!inserts.has(mac)) return false;
    admin.wallet.add(mac, pesos);
    armInsert(mac);
    admin.mainlog.write('system', `Coin: ${pesos} peso(s) added to the wallet of ${mac}`);
    admin.clientLog.write(mac, `Coin: ${pesos} peso(s) to wallet`);
    try { admin.sales.add({ kind: 'coin', amount: pesos, mac, vendo }); } catch (e) { log('error', 'sales record failed', { error: e.message }); }
    portalIo.pushTo(mac, PORTAL_KEYS[20], { credit: admin.wallet.balance(mac), incoin: pesos });
    return true;
  };
  attachWire(server, { events: admin.resellerEvents, sessions: admin.resellerSessions, log, cookieName: 'vendo5_rsid', path: '/reseller', landing: '/reseller' });
}

server.listen(portalPort, () => {
  log('info', 'portal listening', { port: server.address().port });
});

// Coin crediting lives at the top level so a sub-vendo's coins (over the poll protocol) work even when this
// machine has no GPIO. `vendo` is 'main' (this box's own slot) or a sub-vendo id.
const batches = new Map(); // mac -> { pesos, ms, at }: coins inserted close together are one purchase
const vc = config.vendo;
function creditPulse(vendo = 'main') {
  const mac = consumePendingPayer(Date.now(), vendo);
  if (!mac) {
    log('warn', 'orphan coin pulse: no pending payer', { vendo });
    return;
  }
  if (admin && admin.money.blocked(mac)) {
    log('warn', 'coin from a blocked device ignored', { mac });
    return;
  }
  if (admin && admin.portalCoin(mac, pulse_value_pesos, vendo)) return;
  const cfg = admin ? admin.settings.read().main : null;
  const t = Date.now();
  let b = batches.get(mac);
  if (!b || t - b.at > (cfg ? cfg.countdownMax : 15) * 1000) b = { pesos: 0, ms: 0 };
  b.pesos += pulse_value_pesos;
  b.at = t;
  const total = timeForPesos(cfg ? cfg.config : { rate: [] }, b.pesos, pesos_per_minute);
  const delta = total - b.ms;
  b.ms = total;
  batches.set(mac, b);
  const existing = session.getSession(mac);
  const fresh = !existing || (!existing.paused && existing.expiresAt <= t);
  session.addTime(mac, delta, { price: pulse_value_pesos, ...(fresh && cfg ? profileFor(cfg.config, b.pesos) : {}) }, t);
  if (admin) {
    admin.mainlog.write('system', `Coin: ${pulse_value_pesos} peso(s) credited to ${mac}`);
    admin.clientLog.write(mac, `Coin: ${pulse_value_pesos} peso(s)`);
    try { admin.sales.add({ kind: 'coin', amount: pulse_value_pesos, mac, vendo }); } catch (e) { log('error', 'sales record failed', { error: e.message }); }
  }
  if (!(existing && existing.paused)) {
    try {
      firewall.allow(mac);
      log('info', 'firewall allow', { mac });
    } catch (e) {
      log('error', 'firewall allow failed', { mac, error: e.message });
    }
  }
  session.save();
}

// One coin guard per vendo. Main's onLock drives the physical relay; a sub-vendo's acceptor relay is the ESP's.
makeGuard = (vendo) => createCoinGuard({
  onCoin: (pulses) => { for (let i = 0; i < pulses; i++) creditPulse(vendo); },
  hasPayer: () => hasPendingPayer(Date.now(), vendo),
  notify: (title, message) => { try { notifications.add({ title, icon: 'mdi-alert', message }); } catch (e) { log('error', 'notification failed', { error: e.message }); } },
  log: (text) => { const t = vendo === 'main' ? text : `${vendo}: ${text}`; log('warn', t); if (admin) admin.mainlog.write('system', t); },
  onLock: vendo === 'main' ? (locked) => { if (locked) coinRelay(false); else if (hasMainInsert()) coinRelay(true); } : () => {},
  // calibration for other coin acceptors: optional keys in vendo.json
  ...(vc.coin_min_gap_ms !== undefined && { minGapMs: Number(vc.coin_min_gap_ms) }),
  ...(vc.coin_train_gap_ms !== undefined && { trainGapMs: Number(vc.coin_train_gap_ms) }),
  ...(vc.coin_max_pulses !== undefined && { maxPulses: Number(vc.coin_max_pulses) }),
});

// Sub-vendo poll handler: credit a vendo's coins through its guard, switch its acceptor relay when a phone holds
// its slot, and report bad signatures to the main log.
subApi = admin ? createSubvendoApi({
  vendos: admin.vendos,
  vendoKey: () => admin.settings.read().key,
  credit: (vendo, pulses, gap) => { const g = guardOf(vendo); if (g) g.train(pulses, gap); },
  relayOn: (vendo) => hasPendingPayer(Date.now(), vendo) && !coinLocked(vendo),
  log: (t) => admin.mainlog.write('system', t),
}) : null;

// A missing/unwritable coin pin must not take the portal and admin down with it.
const gpio = createGpio(gpioBase);
const live = admin ? admin.settings.read().main : null;
const pin = live ? Number(live.pins.incoin) || coin_pin : coin_pin;
const edge = live && ['rising', 'falling', 'both'].includes(live.edge) ? live.edge : 'rising';
const relayPin = live && String(live.pins.relay ?? '') !== '' ? Number(live.pins.relay) : NaN;
if (Number.isInteger(relayPin) && relayPin >= 0) {
  const active = Number(live.relaypinactive) === 0 ? 0 : 1;
  try {
    gpio.exportPin(relayPin);
    coinRelay = (on) => {
      try {
        gpio.writePin(relayPin, on ? active : 1 - active);
        return true;
      } catch (e) {
        log('error', 'coin relay write failed', { pin: relayPin, error: e.message });
        return false;
      }
    };
    if (coinRelay(false)) log('info', 'main coin slot power cut at startup', { pin: relayPin });
  } catch (e) {
    log('error', 'main coin slot relay unavailable', { pin: relayPin, error: e.message });
  }
}
try {
  gpio.exportPin(pin);
  gpio.watchPin(pin, 'in', edge, (value) => {
    if (value === (edge === 'falling' ? 0 : 1)) guardOf('main').pulse();
  });
} catch (e) {
  log('error', 'coin gpio unavailable; portal runs without coin input', { pin, error: e.message });
}

// Speed limits and data caps (nft `bwlimit` chain); a device over its cap loses its session.
if (admin) {
  const wan = (() => { try { return /^define WAN = "([\w.-]+)"/m.exec(require('node:fs').readFileSync(process.env.VENDO5_NFT || '/etc/vendo5-firewall.nft', 'utf8'))[1]; } catch { return 'eth0'; } })(); // the boot-time detector's answer
  const shaper = createShaper({ runCommand, wan, sessions: session, arp, file: path.join(stateDir, 'limits.nft'), save: () => session.save(), log,
    onCap: (mac) => { admin.money.endSession(mac); admin.mainlog.write('system', `Data cap reached: session of ${mac} ended`); admin.clientLog.write(mac, 'Data cap reached'); } });
  setInterval(() => { try { shaper.tick(); } catch (e) { log('error', 'bandwidth limit pass failed', { error: e.message }); } }, 2000).unref();
}

// Internet/LAN watchdog. Off OpenWrt (a laptop) there is no br-lan to look after, so only the ping/freeze part runs.
{
  const nodeFs = require('node:fs');
  const { execFile } = require('node:child_process');
  const onOpenWrt = nodeFs.existsSync('/etc/openwrt_release');
  const exec = (argv) => new Promise((ok, fail) => execFile(argv[0], argv.slice(1), { timeout: 15000 }, (e, out) => (e ? fail(e) : ok(out))));
  const watchdog = createWatchdog({
    exec,
    linkExists: (dev) => !onOpenWrt || nodeFs.existsSync(`/sys/class/net/${dev}`),
    sessions: session,
    firewall,
    notifications,
    mainlog: admin ? admin.mainlog : { write: (c, text) => log('info', text) },
    save: () => session.save(),
  });
  setInterval(() => { watchdog.tick().catch((e) => log('error', 'watchdog pass failed', { error: e.message })); }, 30000).unref();
}

setInterval(() => {
  const due = session.expireDue();
  for (const mac of due) {
    try {
      firewall.revoke(mac);
    } catch (e) {
      log('error', 'firewall revoke failed', { mac, error: e.message });
    }
  }
  if (due.length) session.save();
}, 1000);
