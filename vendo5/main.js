const path = require('node:path');
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

const { coin_pin, pulse_value_pesos, pesos_per_minute } = config.vendo;

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
  const settings = createSettings({ file: path.join(stateDir, 'settings.json'), deviceName, coinPin: coin_pin });
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
    ...createSettingsHandlers({ settings, mainlog, deviceName, restart, version, lanInterface: config.network.lan_interface }),
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
  const ops = createPortalOps({ sessions: session, firewall, clients, credits, sales, settings, access, mainlog, clientLog, save: () => session.save() });
  const wallet = createWallet({ clients, sessions: session, firewall, settings, ratePesosPerMinute: () => pesos_per_minute, access, mainlog, clientLog, save: () => session.save() });
  const portalPages = createPortalPages({ root: uiDir, version, hostname: deviceName, keys: PORTAL_KEYS, hide: () => ({}),
    theme: () => settings.read().portalTheme.set || 'defualt-theme', redirect: () => settings.read().redirect, custom: () => { const t = settings.read().portalTheme; return t.enable ? t.script : ''; },
    headScript: process.env.VENDO5_PROBE_JS ? `<script>${require('node:fs').readFileSync(process.env.VENDO5_PROBE_JS, 'utf8')}</script>` : '' });
  const portalEvents = createPortalHandlers({ sessions: session, money, ops, wallet, clients, settings, clientLog, chat: { clientHasUnread: (m) => chat.clientHasUnread(m), markClientSeen: (m) => chat.markClientSeen(m), history: (m) => chat.history(m), send: (m, t) => clientSend({ chat, push }, m, t) }, media, vouchers, arp, version,
    listenCoin: (mac, socket) => hooks.listenCoin(mac, socket), stopCoin: (mac) => hooks.stopCoin(mac), ratePesosPerMinute: () => pesos_per_minute });
  const themeResolver = createThemeResolver({ log, handlers: { handshake: { fallback: {}, handler: () => ({ footer: settings.read().footer, hostname: deviceName.toUpperCase(), version, redirect: String(settings.read().redirect || ''), options: { ...defaultHide(), defaulttheme: false }, customTheme: '', ioKey: PORTAL_KEYS, redirecturl: '' }) } } });
  const resellers = createResellers({ file: path.join(stateDir, 'resellers.json') });
  const resellerSessions = createSessions({});
  const resellerRoutes = createResellerRoutes({ root: uiDir, version, hostname: deviceName, sessions: resellerSessions, resellers });
  const resellerEvents = createResellerPortalHandlers({ sessions: resellerSessions, resellers, vouchers, credits, tickets, sales, licence, mainlog, version });
  events['@nav-00112347'] = createResellerAdminHandlers({ resellers, mainlog })['@nav-00112347'];
  const routes = (req, res) => resellerRoutes(req, res) || adminRoutes(req, res);
  admin = { themeResolver, portalPages, portalEvents, hooks, wallet, sessionsStore: session, serveStatic: createStatic({ root: uiDir }), chatApi: { history: (m) => chat.history(m), send: (m, t) => clientSend({ chat, push }, m, t), seen: (m) => chat.markClientSeen(m) }, setPush: (f) => { pushToAdmins = f; }, routes, events, sessions, resellerEvents, resellerSessions, mainlog, money, sales, access, clientLog, settings };
} catch (e) {
  log('error', 'admin page unavailable; the portal runs without it', { error: e.message });
}

const { server, consumePendingPayer, setPendingPayer, hasPendingPayer } = createServer({ session, arp, ratePesosPerMinute: pesos_per_minute, adminRoutes: admin && admin.routes, money: admin && admin.money, chat: admin && admin.chatApi,
  portal: admin && { render: (p) => admin.portalPages.render(p), themeDir: () => admin.portalPages.themeDir(), serveStatic: admin.serveStatic } });
const inserts = new Map(); // mac -> { timer }: devices with the portal's coin popup open
// Coin acceptor power (relay pin from Pin Setup): on while a coin popup is open and the slot is not locked,
// off coinsBlockerDelay ms after the last popup closes so a coin already falling is still counted.
let coinRelay = () => {}; // set once the gpio is up and a relay pin is configured
let coinLocked = () => false;
let relayOffTimer = null;
const openCoinSlot = () => { clearTimeout(relayOffTimer); if (!coinLocked()) coinRelay(true); };
const closeCoinSlotSoon = () => {
  clearTimeout(relayOffTimer);
  const delay = admin ? Number(admin.settings.read().main.coinsBlockerDelay) || 0 : 0;
  relayOffTimer = setTimeout(() => { if (!inserts.size) coinRelay(false); }, delay);
};
const endInsert = (mac, io) => { const i = inserts.get(mac); if (!i) return; clearTimeout(i.timer); inserts.delete(mac); if (!inserts.size) closeCoinSlotSoon(); io.pushTo(mac, PORTAL_KEYS[21], { done: true, countdown: 0, countdownMax: 0, type: 'info', message: '' }); };
if (admin) {
  const adminIo = attachWire(server, { events: admin.events, sessions: admin.sessions, log });
  admin.setPush((ev, payload) => adminIo.pushAuthed(ev, payload));
  const portalIo = attachPortal(server, { events: admin.portalEvents, identify: (sock) => arp.ipToMac(String(sock.handshake.address || '').replace(/^::ffff:/, '')), log, ...admin.themeResolver });
  const armInsert = (mac) => {
    const old = inserts.get(mac);
    if (old) clearTimeout(old.timer);
    const wait = admin.settings.read().main.countdownMax * 1000;
    inserts.set(mac, { timer: setTimeout(() => endInsert(mac, portalIo), wait) });
    return wait;
  };
  admin.hooks.listenCoin = (mac) => {
    if (admin.money.blocked(mac)) return { ok: false, message: 'This device is blocked' };
    if (coinLocked()) return { ok: false, message: 'Coin slot is temporarily locked, try again in a few minutes' };
    const wait = admin.settings.read().main.countdownMax * 1000;
    if (!setPendingPayer(mac, Date.now(), wait + 2000)) return { ok: false, message: 'Vendo is busy, someone else is inserting coins' };
    armInsert(mac);
    openCoinSlot();
    return { ok: true, countdown: wait / 1000, expiry: Date.now() + wait };
  };
  admin.hooks.stopCoin = (mac) => endInsert(mac, portalIo);
  // a coin while the popup is open goes to the device's wallet (the Done/Connect button turns it into time)
  admin.portalCoin = (mac, pesos) => {
    if (!inserts.has(mac)) return false;
    admin.wallet.add(mac, pesos);
    armInsert(mac);
    admin.mainlog.write('system', `Coin: ${pesos} peso(s) added to the wallet of ${mac}`);
    admin.clientLog.write(mac, `Coin: ${pesos} peso(s) to wallet`);
    try { admin.sales.add({ kind: 'coin', amount: pesos, mac }); } catch (e) { log('error', 'sales record failed', { error: e.message }); }
    portalIo.pushTo(mac, PORTAL_KEYS[20], { credit: admin.wallet.balance(mac), incoin: pesos });
    return true;
  };
  attachWire(server, { events: admin.resellerEvents, sessions: admin.resellerSessions, log, cookieName: 'vendo5_rsid', path: '/reseller', landing: '/reseller' });
}

server.listen(portalPort, () => {
  log('info', 'portal listening', { port: server.address().port });
});

// A missing/unwritable coin pin must not take the portal and admin down with it.
try {
  const gpio = createGpio(gpioBase);
  const live = admin ? admin.settings.read().main : null;
  const pin = live ? Number(live.pins.incoin) || coin_pin : coin_pin;
  const edge = live && ['rising', 'falling', 'both'].includes(live.edge) ? live.edge : 'rising';
  gpio.exportPin(pin);
  const relayPin = live && String(live.pins.relay ?? '') !== '' ? Number(live.pins.relay) : NaN;
  if (Number.isInteger(relayPin) && relayPin >= 0) {
    const active = Number(live.relaypinactive) === 0 ? 0 : 1;
    gpio.exportPin(relayPin);
    coinRelay = (on) => { try { gpio.writePin(relayPin, on ? active : 1 - active); } catch (e) { log('error', 'coin relay write failed', { pin: relayPin, error: e.message }); } };
    coinRelay(false);
  }
  const batches = new Map(); // mac -> { pesos, ms, at }: coins inserted close together are one purchase
  const vc = config.vendo;
  const guard = createCoinGuard({
    onCoin: (pulses) => { for (let i = 0; i < pulses; i++) creditPulse(); },
    hasPayer: () => hasPendingPayer(),
    notify: (title, message) => { try { notifications.add({ title, icon: 'mdi-alert', message }); } catch (e) { log('error', 'notification failed', { error: e.message }); } },
    log: (text) => { log('warn', text, { pin }); if (admin) admin.mainlog.write('system', text); },
    onLock: (locked) => { if (locked) coinRelay(false); else if (inserts.size) coinRelay(true); },
    // calibration for other coin acceptors: optional keys in vendo.json
    ...(vc.coin_min_gap_ms !== undefined && { minGapMs: Number(vc.coin_min_gap_ms) }),
    ...(vc.coin_train_gap_ms !== undefined && { trainGapMs: Number(vc.coin_train_gap_ms) }),
    ...(vc.coin_max_pulses !== undefined && { maxPulses: Number(vc.coin_max_pulses) }),
  });
  coinLocked = guard.isLocked;
  gpio.watchPin(pin, 'in', edge, (value) => {
    if (value === (edge === 'falling' ? 0 : 1)) guard.pulse();
  });
  function creditPulse() {
    const mac = consumePendingPayer();
    if (!mac) {
      log('warn', 'orphan coin pulse: no pending payer', { pin });
      return;
    }
    if (admin && admin.money.blocked(mac)) {
      log('warn', 'coin from a blocked device ignored', { mac });
      return;
    }
    if (admin && admin.portalCoin(mac, pulse_value_pesos)) return;
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
      try { admin.sales.add({ kind: 'coin', amount: pulse_value_pesos, mac }); } catch (e) { log('error', 'sales record failed', { error: e.message }); }
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
} catch (e) {
  log('error', 'coin gpio unavailable; portal runs without coin input', { pin: coin_pin, error: e.message });
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
