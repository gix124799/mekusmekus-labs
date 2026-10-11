// The read/modify commands the network pages send through @nav-23441, as an allowlist. Each allowed line maps to one
// argv (never a shell string); anything else is refused by returning undefined. On OpenWrt the answers are the real
// tools'; on a machine without ubus the same questions are answered from the emulated uci and plain `ip`.
const IFACE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const DEV = /^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/;

// stdout -> what the page wants: parsed JSON, else the text, else {stdout:'', stderr}
function shape(out, err) {
  const t = String(out || '').trim();
  if (t) {
    if (t[0] === '{' || t[0] === '[') { try { return JSON.parse(t); } catch { /* plain text that starts with a brace */ } }
    return t;
  }
  return { stdout: '', stderr: err || '' };
}

function createNetCommands({ runCommand, uci }) {
  const emulated = uci.emulated;
  const exec = (argv) => {
    try {
      return shape(runCommand(argv), '');
    } catch (e) {
      const stderr = String((e && e.stderr) || (e && e.message) || 'Command failed').trim().split('\n')[0].slice(0, 200);
      return { stdout: '', stderr };
    }
  };
  const ipJson = (argv) => {
    try { return JSON.parse(runCommand(argv) || '[]'); } catch { return []; }
  };

  // A development machine has no eth0/eth1 like the Orange Pi's; the pages need them, so emulation supplies stand-ins.
  const fakeLink = (n) => ({ ifindex: n === 'eth0' ? 2 : 3, ifname: n, flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'], mtu: 1500, qdisc: 'fq_codel', operstate: 'UP', group: 'default', txqlen: 1000, link_type: 'ether', address: n === 'eth0' ? '52:54:00:12:34:56' : '52:54:00:12:34:57', broadcast: 'ff:ff:ff:ff:ff:ff' });
  const withStandIns = (list) => {
    const arr = Array.isArray(list) ? list : [];
    for (const n of ['eth0', 'eth1']) if (!arr.some((l) => l.ifname === n)) arr.push(fakeLink(n));
    return arr;
  };

  // ---- emulation of ubus network.* (no ubus: development machine)
  function emuInterface(name) {
    const sec = uci.call('get', { config: 'network', section: name }).values;
    if (!sec || sec['.type'] !== 'interface') return { stdout: '', stderr: 'Command failed: Not found' };
    const dev = sec.device || sec.ifname || name;
    const out = { up: true, pending: false, available: true, autostart: true, proto: sec.proto || 'none', device: dev, l3_device: dev, uptime: Math.floor(process.uptime()), 'ipv4-address': [], 'ipv6-address': [], route: [], 'dns-server': [] };
    if (sec.proto === 'static' && sec.ipaddr) {
      const bits = String(sec.netmask || '255.255.255.0').split('.').reduce((n, o) => n + Number(o).toString(2).replace(/0/g, '').length, 0);
      out['ipv4-address'].push({ address: sec.ipaddr, mask: bits });
    } else {
      const a = ipJson(['ip', '-j', 'addr', 'show', 'dev', DEV.test(dev) ? dev : 'lo'])[0];
      for (const i of (a && a.addr_info) || []) if (i.family === 'inet') out['ipv4-address'].push({ address: i.local, mask: i.prefixlen });
      // a DHCP uplink that does not exist on this machine: show the address a typical lease would give
      if (!out['ipv4-address'].length && sec.proto === 'dhcp') { out['ipv4-address'].push({ address: '10.0.2.15', mask: 24 }); out['dns-server'] = ['10.0.2.3']; }
    }
    if (sec.dns) out['dns-server'] = Array.isArray(sec.dns) ? sec.dns : [sec.dns];
    return out;
  }
  function emuDevice(name) {
    const l = ipJson(['ip', '-j', 'link', 'show', 'dev', name])[0] || (/^eth\d$/.test(name) ? fakeLink(name) : null);
    if (!l) return { stdout: '', stderr: 'Command failed: Not found' };
    return { type: 'Network device', up: l.operstate !== 'DOWN', carrier: l.operstate === 'UP', macaddr: l.address || '', mtu: l.mtu, speed: '1000F', 'link-supported': ['10baseT-H', '10baseT-F', '100baseT-H', '100baseT-F', '1000baseT-F'] };
  }
  function emuWireless() {
    const all = uci.call('get', { config: 'wireless' }).values || {};
    const out = {};
    for (const [n, s] of Object.entries(all)) {
      if (s['.type'] !== 'wifi-device') continue;
      const ifaces = Object.values(all).filter((i) => i['.type'] === 'wifi-iface' && i.device === n).map((i, k) => ({ section: i['.name'], ifname: `wlan${k}`, config: i }));
      out[n] = { up: !s.disabled || s.disabled === '0', pending: false, autostart: true, disabled: s.disabled === '1', retry_setup_failed: false, config: s, interfaces: ifaces };
    }
    return out;
  }

  function uciLine(line) {
    const m = /^ubus call uci (get|set|add|delete|commit|changes|revert) '(.*)'$/s.exec(line);
    if (!m) return undefined;
    let req;
    try { req = JSON.parse(m[2]); } catch { return { stdout: '', stderr: 'Invalid JSON' }; }
    if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.config !== 'string') return { stdout: '', stderr: 'Invalid argument' };
    return uci.call(m[1], req);
  }

  return function run(line) {
    if (typeof line !== 'string' || line.length > 6000) return undefined;
    let m;
    if (line.startsWith('ubus call uci ')) return uciLine(line);
    if ((m = /^ubus call network\.interface\.([A-Za-z0-9_]+) status$/.exec(line)) && IFACE.test(m[1])) return emulated ? emuInterface(m[1]) : exec(['ubus', 'call', `network.interface.${m[1]}`, 'status']);
    if ((m = /^ubus call network\.device status(?: '\{ ?"name": ?"([A-Za-z0-9._-]{1,15})" ?\}')?$/.exec(line))) {
      if (m[1]) return emulated ? emuDevice(m[1]) : exec(['ubus', 'call', 'network.device', 'status', JSON.stringify({ name: m[1] })]);
      return emulated ? {} : exec(['ubus', 'call', 'network.device', 'status']);
    }
    if (line === 'ubus call network.wireless status') return emulated ? emuWireless() : exec(['ubus', 'call', 'network.wireless', 'status']);
    if (line === 'ubus call system board') return exec(['ubus', 'call', 'system', 'board']);
    if (line === 'ip -j neigh' || line === 'ip -j neigh show') return exec(['ip', '-j', 'neigh', 'show']);
    if (line === 'ip -j route' || line === 'ip -j route show') return exec(['ip', '-j', 'route', 'show']);
    if ((m = /^ip -j -d route show table (\d{1,5})$/.exec(line))) return exec(['ip', '-j', '-d', 'route', 'show', 'table', m[1]]);
    if (line === 'ip -j -d link show' || line === 'ip -j link show') { const r = exec(['ip', '-j', '-d', 'link', 'show']); return emulated ? withStandIns(r) : r; }
    if ((m = /^ip -j -d link show dev ([A-Za-z0-9._-]{1,15})$/.exec(line))) {
      const r = exec(['ip', '-j', '-d', 'link', 'show', 'dev', m[1]]);
      return emulated && (!Array.isArray(r) || r.length === 0) && /^eth\d$/.test(m[1]) ? [fakeLink(m[1])] : r;
    }
    if ((m = /^wg show ([A-Za-z0-9_-]{1,15})$/.exec(line))) return exec(['wg', 'show', m[1]]);
    if ((m = /^iw dev ([A-Za-z0-9._-]{1,15}) station dump$/.exec(line))) return emulated ? '' : exec(['iw', 'dev', m[1], 'station', 'dump']);
    return undefined;
  };
}

module.exports = { createNetCommands, shape };
