const fs = require('node:fs');

// dnsmasq's lease file: "<expiry epoch s> <mac> <ip> <hostname|*> <client id>" per line.
function parseLeases(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || !/^\d+$/.test(f[0]) || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(f[1]) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(f[2])) continue;
    out.push({ timeout: Number(f[0]), mac: f[1].toLowerCase(), ip: f[2], hostname: f[3] === '*' ? '' : f[3].slice(0, 63) });
  }
  return out;
}

// What @nav-99800 answers: { cIfname: { <mac>: { ip, hostname, timeout, ifname } }, date }. ifname comes from the
// neighbour table (the interface the device is behind), br-lan when unknown.
function readLeases({ file, neighbors, now = Date.now, fsRead = (f) => fs.readFileSync(f, 'utf8') }) {
  let text = '';
  try { text = fsRead(file); } catch { /* no lease file yet: no leases */ }
  const neigh = neighbors();
  const cIfname = {};
  for (const l of parseLeases(text)) cIfname[l.mac] = { ip: l.ip, hostname: l.hostname, timeout: l.timeout, ifname: (neigh[l.mac] && neigh[l.mac].dev) || 'br-lan' };
  return { cIfname, date: now() };
}

module.exports = { parseLeases, readLeases };
