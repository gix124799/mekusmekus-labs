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
const { createSessions } = require('./lib/wire/session');
const { createMainHandlers } = require('./lib/wire/main');
const { createNavHandlers } = require('./lib/wire/nav');
const { createMoneyHandlers } = require('./lib/wire/money');
const { createSalesHandlers } = require('./lib/wire/sales');
const { createDeviceHandlers } = require('./lib/wire/devices');
const { createSettingsHandlers } = require('./lib/wire/settings');
const { createSettings } = require('./lib/store/settings');
const { timeForPesos, profileFor } = require('./lib/money/rates');
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

// shortcut: no-op shell-out for firewall/arp when VENDO5_FIREWALL_CMD=noop
// (used by the smoke test, which has no real nft/ip environment). Real
// deployments never set this, so production always shells out for real.
const runCommand = process.env.VENDO5_FIREWALL_CMD === 'noop'
  ? () => ''
  : (args) => {
      const { execFileSync } = require('node:child_process');
      return execFileSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 5000 }); // a hung command must not freeze the event loop for long
    };

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
  const routes = createAdminRoutes({ pages, sessions, serveStatic: createStatic({ root: uiDir }) });
  const stats = createStats({ runCommand });
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
  const events = {
    ...createSettingsHandlers({ settings, mainlog, deviceName, restart, version, lanInterface: config.network.lan_interface }),
    ...createDeviceHandlers({ clients, access, clientLog, sessions: session, money, firewall, mainlog, save: () => session.save() }),
    ...createSalesHandlers({ sales, deviceName, mainlog }),
    ...createMoneyHandlers({ vouchers, credits, tickets, sessions: session, mainlog, endSession: money.endSession, save: () => session.save() }),
    ...createMainHandlers({ account, sessions, licence, mainlog, version }),
    ...createNavHandlers({
      sessions: session,
      firewall,
      arp,
      stats,
      passthrough: createPassthrough({ runCommand, reboot: () => runCommand(['reboot']), systemInfo: stats.systemInfo }),
      mainlog,
      notifications: createNotifications({ file: path.join(stateDir, 'notification.json') }),
      licence,
      account,
      save: () => session.save(),
    }),
  };
  admin = { routes, events, sessions, mainlog, money, sales, access, clientLog, settings };
} catch (e) {
  log('error', 'admin page unavailable; the portal runs without it', { error: e.message });
}

const { server, consumePendingPayer } = createServer({ session, arp, ratePesosPerMinute: pesos_per_minute, adminRoutes: admin && admin.routes, money: admin && admin.money });
if (admin) attachWire(server, { events: admin.events, sessions: admin.sessions, log });

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
  const batches = new Map(); // mac -> { pesos, ms, at }: coins inserted close together are one purchase
  gpio.watchPin(pin, 'in', edge, (value) => {
    if (value !== (edge === 'falling' ? 0 : 1)) return;
    const mac = consumePendingPayer();
    if (!mac) {
      log('warn', 'orphan coin pulse: no pending payer', { pin });
      return;
    }
    if (admin && admin.money.blocked(mac)) {
      log('warn', 'coin from a blocked device ignored', { mac });
      return;
    }
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
  });
} catch (e) {
  log('error', 'coin gpio unavailable; portal runs without coin input', { pin: coin_pin, error: e.message });
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
