function createArp(runCommand) {
  function ipToMac(ip) {
    let out;
    try {
      out = runCommand(['ip', 'neigh', 'show', ip]);
    } catch {
      return null;
    }
    const match = /lladdr\s+([0-9a-f:]{17})/i.exec(out || '');
    return match ? match[1] : null;
  }

  return { ipToMac };
}

module.exports = { createArp };
