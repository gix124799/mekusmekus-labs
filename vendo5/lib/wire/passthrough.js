// @nav-23441: the admin pages ask for device facts (and, on the network pages, change settings) by sending a command
// line. The original ran any line matching its regex allowlist; here each allowed line maps to a fixed argv and
// nothing else runs. System info and reboot live here; the network commands are in lib/system/netcmd.js.
const IFACE = /^ubus call network\.interface\.(wan|wan2|wg0) status$/;

function createPassthrough({ runCommand, reboot, systemInfo, net }) {
  const parse = (out) => {
    try {
      return JSON.parse(out);
    } catch {
      return {};
    }
  };
  return function run(line) {
    if (typeof line !== 'string') return {};
    try {
      if (line === 'ubus call system info') {
        const out = parse(runCommand(['ubus', 'call', 'system', 'info']));
        return out.uptime === undefined ? systemInfo() : out;
      }
      if (line === 'ubus call system reboot') {
        reboot(); // the page treats stdout === '' as "Restarting"
        return { stdout: '' };
      }
    } catch {
      // No ubus (not OpenWrt): the uptime still has an answer.
      if (line === 'ubus call system info') return systemInfo();
      return {};
    }
    const r = net ? net(line) : undefined;
    return r === undefined ? {} : r;
  };
}

module.exports = { createPassthrough };
