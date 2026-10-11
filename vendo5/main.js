const os = require('node:os');
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
const { createPassthrough } = require('./lib/wire/passthrough');
const { attachWire } = require('./lib/wire/server');
const { version } = require('./package.json');

const configDir = process.env.VENDO5_CONFIG_DIR || '/mnt/wifi5/vendo5-config';
const defaultsDir = process.env.VENDO5_DEFAULTS_DIR || '/opt/vendo5/config';
const sessionFile = process.env.VENDO5_SESSION_FILE || '/mnt/wifi5/vendo5-sessions.json';
const gpioBase = process.env.VENDO5_GPIO_BASE || '/sys/class/gpio';
const uiDir = process.env.VENDO5_UI_DIR || '/opt/vendo5/ui';
const stateDir = process.env.VENDO5_STATE_DIR || '/mnt/wifi5/vendo5';
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
  firewall.syncFromSessions(session.all());
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
  const pages = createPages({ root: uiDir, version, hostname: os.hostname() });
  const routes = createAdminRoutes({ pages, sessions, serveStatic: createStatic({ root: uiDir }) });
  const stats = createStats({ runCommand });
  const events = {
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
  admin = { routes, events, sessions, mainlog };
} catch (e) {
  log('error', 'admin page unavailable; the portal runs without it', { error: e.message });
}

const { server, consumePendingPayer } = createServer({ session, arp, ratePesosPerMinute: pesos_per_minute, adminRoutes: admin && admin.routes });
if (admin) attachWire(server, { events: admin.events, sessions: admin.sessions, log });

server.listen(portalPort, () => {
  log('info', 'portal listening', { port: server.address().port });
});

// A missing/unwritable coin pin must not take the portal and admin down with it.
try {
  const gpio = createGpio(gpioBase);
  gpio.exportPin(coin_pin);
  gpio.watchPin(coin_pin, 'in', 'rising', (value) => {
    if (value !== 1) return;
    const mac = consumePendingPayer();
    if (!mac) {
      log('warn', 'orphan coin pulse: no pending payer', { pin: coin_pin });
      return;
    }
    session.addCredit(mac, pulse_value_pesos, pesos_per_minute);
    if (admin) admin.mainlog.write('system', `Coin: ${pulse_value_pesos} peso(s) credited to ${mac}`);
    try {
      firewall.allow(mac);
      log('info', 'firewall allow', { mac });
    } catch (e) {
      log('error', 'firewall allow failed', { mac, error: e.message });
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
