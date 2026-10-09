const { log } = require('./logger');

// shortcut: a single flat "vendo5-allow" set/chain, add/remove by MAC; no
// per-interface or per-VLAN scoping. Revisit if sub-project #2's hardware
// testing needs more than one LAN segment gated.
function createFirewall(runCommand) {
  function allow(mac) {
    runCommand(['nft', 'add', 'element', 'inet', 'vendo5', 'allowed', '{', mac, '}']);
  }

  function revoke(mac) {
    runCommand(['nft', 'delete', 'element', 'inet', 'vendo5', 'allowed', '{', mac, '}']);
  }

  function syncFromSessions(sessionsByMac) {
    for (const mac of Object.keys(sessionsByMac)) {
      try {
        allow(mac);
      } catch (e) {
        log('error', `firewall sync failed for mac`, { mac, error: e.message });
      }
    }
  }

  return { allow, revoke, syncFromSessions };
}

module.exports = { createFirewall };
