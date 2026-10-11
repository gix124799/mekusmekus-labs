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

  // mac -> { ip, dev } for every neighbour with a link-layer address (the dashboard's address column).
  function neighbors() {
    const out = {};
    let text = '';
    try {
      text = runCommand(['ip', 'neigh', 'show']) || '';
    } catch {
      return out;
    }
    for (const line of text.split('\n')) {
      const m = /^(\S+)\s+dev\s+(\S+)\s+lladdr\s+([0-9a-f:]{17})/i.exec(line);
      if (m) out[m[3].toLowerCase()] = { ip: m[1], dev: m[2] };
    }
    return out;
  }

  return { ipToMac, neighbors };
}

module.exports = { createArp };
