// Internet and LAN watchdog, ticked every 30 s by main.js. While the internet is down, client time is frozen
// (sessions.freeze) and given back when it returns (sessions.thaw). Commands are async: a blocked event loop
// would delay coin-pulse reads. App crashes (procd respawn) and kernel hangs (hardware watchdog) are not
// handled here.
const WAN_HOSTS = ['1.1.1.1', '8.8.8.8'];
const FAILS_TO_DOWN = 3;
const WAN_RETRY_MS = 10 * 60000;
const LAN_RETRY_MS = 5 * 60000;

function createWatchdog({ exec, linkExists, sessions, firewall, notifications, mainlog, save = () => {}, now = Date.now }) {
  let fails = 0;
  let outageSince = null;
  let lastWanTry = 0;
  let notifiedDown = false;
  let lastOkAt = null;
  let recoveries = 0;
  let lanMissing = false;
  let lastLanTry = 0;
  let busy = false;

  const log = (text) => mainlog.write('system', text);
  const notify = (title, message) => {
    try { notifications.add({ title, icon: 'mdi-wifi-alert', message }); } catch (e) { log(`Watchdog notification failed: ${e.message}`); }
  };
  const run = (argv) => exec(argv).then(() => true, (e) => { log(`Watchdog: ${argv.join(' ')} failed: ${e.message}`); return false; });
  const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

  async function online() {
    for (const host of WAN_HOSTS) {
      try { await exec(['ping', '-c', '1', '-W', '2', host]); return true; } catch { /* try the next host */ }
    }
    return false;
  }

  async function checkLan() {
    const t = now();
    if (linkExists('br-lan')) {
      if (lanMissing) log('Watchdog: LAN is back');
      lanMissing = false;
      return;
    }
    if (!lanMissing) {
      lanMissing = true;
      lastLanTry = 0;
      log('Watchdog: br-lan is missing, re-detecting ports');
      notify('LAN adapter missing', 'br-lan is gone: check the USB LAN adapter');
    }
    if (t - lastLanTry < LAN_RETRY_MS) return;
    lastLanTry = t;
    await run(['/etc/vendo5-netdetect.sh']);
    await run(['ifup', 'lan']);
  }

  async function checkWan() {
    const ok = await online();
    const t = now();
    if (ok) {
      fails = 0;
      lastOkAt = t;
      const macs = sessions.thaw(t);
      for (const mac of macs) {
        try { firewall.allow(mac); } catch (e) { log(`Watchdog: firewall allow ${mac} failed: ${e.message}`); }
      }
      if (macs.length) save();
      if (outageSince !== null) {
        const mins = Math.round((t - outageSince) / 60000);
        recoveries += 1;
        log(`Watchdog: internet back after ${mins} min, time returned to ${macs.length} clients`);
        notify('Internet back', `Down ${mins} min, time returned to ${macs.length} clients`);
        outageSince = null;
      } else if (macs.length) {
        log(`Watchdog: time returned to ${macs.length} clients frozen before a restart`);
      }
      return;
    }
    fails += 1;
    if (outageSince === null) {
      if (fails < FAILS_TO_DOWN) return;
      outageSince = t;
      lastWanTry = t;
      notifiedDown = false;
      const frozen = sessions.freeze(t);
      save();
      log(`Watchdog: internet down, time frozen for ${frozen.length} clients, restarting wan`);
      await run(['ifup', 'wan']);
    } else if (t - lastWanTry >= WAN_RETRY_MS) {
      lastWanTry = t;
      if (!notifiedDown) { notifiedDown = true; notify('Internet down', `No internet since ${hhmm(outageSince)}`); }
      await run(['ifup', 'wan']);
    }
  }

  async function tick() {
    if (busy) return; // slow pings: the previous pass is still running
    busy = true;
    try {
      await checkLan();
      await checkWan();
    } finally {
      busy = false;
    }
  }

  const status = () => ({ wanUp: outageSince === null, lastOkAt, outageSince, recoveries });

  return { tick, status };
}

module.exports = { createWatchdog };
