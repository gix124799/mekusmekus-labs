const fs = require('node:fs');
const { speedBytesPerSec, dataBytes } = require('../money/limits');

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Per-device speed limits and data caps in the `vendo5` nft table's `bwlimit` chain (see etc-overlay vendo5-firewall.nft).
// The whole chain is rewritten as one `nft -f` transaction whenever the set of limited devices (or an IP) changes.
// Counters ride in the same chain; each tick adds them to the session's usedUp/usedDown, and a device over its cap
// is handed to onCap (which ends its session). Speed limits are policing (excess packets dropped), not queueing.
function createShaper({ runCommand, sessions, arp, file, onCap = () => {}, save = () => {}, log = () => {}, lan = 'br-lan', wan = 'eth0', write = (f, t) => fs.writeFileSync(f, t), now = Date.now }) {
  let signature = null;
  let seen = {}; // counter bytes already added, by rule comment (counters restart at zero when the chain is rewritten)

  // sessions that are allowed through the firewall right now
  function active() {
    const t = now();
    return Object.entries(sessions.all()).filter(([mac, s]) => MAC.test(mac) && !s.paused && !s.disconnected && s.expiresAt > t);
  }

  function rulesFor(mac, s, ip) {
    const out = [];
    const up = speedBytesPerSec(s.upload);
    const down = speedBytesPerSec(s.download);
    const burst = (rate) => Math.max(15000, Math.round(rate / 10));
    if (up) out.push(`add rule inet vendo5 bwlimit iifname "${lan}" oifname "${wan}" ether saddr ${mac} limit rate over ${up} bytes/second burst ${burst(up)} bytes drop`);
    out.push(`add rule inet vendo5 bwlimit iifname "${lan}" oifname "${wan}" ether saddr ${mac} counter comment "v5u:${mac}"`);
    if (ip) {
      if (down) out.push(`add rule inet vendo5 bwlimit iifname "${wan}" oifname "${lan}" ip daddr ${ip} limit rate over ${down} bytes/second burst ${burst(down)} bytes drop`);
      out.push(`add rule inet vendo5 bwlimit iifname "${wan}" oifname "${lan}" ip daddr ${ip} counter comment "v5d:${mac}"`);
    }
    return out;
  }

  // Read the counters, add them to each session's usage, return the macs now over their data cap.
  function harvest() {
    let doc;
    try { doc = JSON.parse(runCommand(['nft', '-j', 'list', 'chain', 'inet', 'vendo5', 'bwlimit']) || ''); } catch { return []; }
    const over = [];
    let changed = false;
    for (const item of doc.nftables || []) {
      const r = item.rule;
      const m = r && /^v5([ud]):(.+)$/.exec(r.comment || '');
      const c = m && (r.expr || []).find((e) => e.counter);
      const s = m && sessions.getSession(m[2]);
      if (!s || !c) continue;
      const delta = c.counter.bytes - (seen[r.comment] || 0);
      seen[r.comment] = c.counter.bytes;
      if (!(delta > 0)) continue;
      const k = m[1] === 'u' ? 'usedUp' : 'usedDown';
      s[k] = (s[k] || 0) + delta;
      changed = true;
    }
    if (changed) save();
    for (const [mac, s] of active()) {
      const cap = dataBytes(s.max_data_limit);
      if (cap && (s.usedUp || 0) + (s.usedDown || 0) >= cap) over.push(mac);
    }
    return over;
  }

  // One pass: harvest usage, enforce caps, and rewrite the chain if the wanted rules differ from what is loaded.
  function tick() {
    const over = harvest();
    for (const mac of over) {
      log('info', 'data cap reached', { mac });
      try { onCap(mac); } catch (e) { log('error', 'data cap enforcement failed', { mac, error: e.message }); }
    }
    const neighbours = arp.neighbors();
    const lines = ['flush chain inet vendo5 bwlimit'];
    for (const [mac, s] of active()) {
      const ip = neighbours[mac] && IPV4.test(neighbours[mac].ip) ? neighbours[mac].ip : null;
      lines.push(...rulesFor(mac, s, ip));
    }
    const text = lines.join('\n') + '\n';
    if (text === signature) return false;
    try {
      write(file, text);
      runCommand(['nft', '-f', file]);
      signature = text;
      seen = {};
    } catch (e) {
      signature = null;
      log('error', 'could not apply the bandwidth limits', { error: e.message });
      return false;
    }
    return true;
  }

  return { tick, harvest, rulesFor };
}

module.exports = { createShaper };
