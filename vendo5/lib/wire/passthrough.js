// @nav-23441: the dashboard asks for read-only device facts as a command line. The original ran any
// line matching its regex allowlist; here each allowed line maps to a fixed argv and nothing else runs.
const IFACE = /^ubus call network\.interface\.(wan|wan2|wg0) status$/;

function createPassthrough({ runCommand, reboot, systemInfo }) {
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
      const m = IFACE.exec(line);
      if (m) return parse(runCommand(['ubus', 'call', `network.interface.${m[1]}`, 'status']));
      if (line === 'ubus call system reboot') {
        reboot(); // the page treats stdout === '' as "Restarting"
        return { stdout: '' };
      }
    } catch {
      // No ubus (not OpenWrt): the interface cards stay absent, but the uptime still has an answer.
      if (line === 'ubus call system info') return systemInfo();
    }
    return {};
  };
}

module.exports = { createPassthrough };
