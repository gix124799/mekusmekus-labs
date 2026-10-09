const { loadConfig } = require('./lib/config');
const { log } = require('./lib/logger');
const { createGpio } = require('./lib/gpio');
const { createSessionStore } = require('./lib/session');
const { createFirewall } = require('./lib/firewall');
const { createArp } = require('./lib/arp');
const { createServer } = require('./lib/portal');
const { version } = require('./package.json');

const configDir = process.env.VENDO5_CONFIG_DIR || '/mnt/wifi5/vendo5-config';
const defaultsDir = process.env.VENDO5_DEFAULTS_DIR || '/opt/vendo5/config';
const sessionFile = process.env.VENDO5_SESSION_FILE || '/mnt/wifi5/vendo5-sessions.json';
const gpioBase = process.env.VENDO5_GPIO_BASE || '/sys/class/gpio';
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
      return execFileSync(args[0], args.slice(1), { encoding: 'utf8' });
    };

const firewall = createFirewall(runCommand);
// shortcut: VENDO5_ARP_FAKE_MAC fixes every client's resolved MAC, for
// tests that need a deterministic payer without a real LAN/ARP table.
// Real deployments never set this.
const arp = process.env.VENDO5_ARP_FAKE_MAC
  ? { ipToMac: () => process.env.VENDO5_ARP_FAKE_MAC }
  : createArp(runCommand);

try {
  firewall.syncFromSessions(session.all());
} catch (e) {
  log('error', 'firewall sync failed at boot', { error: e.message });
}

const { server, consumePendingPayer } = createServer({ session, arp, ratePesosPerMinute: pesos_per_minute });
server.listen(portalPort, () => {
  log('info', 'portal listening', { port: server.address().port });
});

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
  try {
    firewall.allow(mac);
    log('info', 'firewall allow', { mac });
  } catch (e) {
    log('error', 'firewall allow failed', { mac, error: e.message });
  }
  session.save();
});

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
