const nodeFs = require('node:fs');

const readText = (fs, file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// Device figures for the dashboard cards. Every reader degrades to an empty value: a missing
// /sys file or a failing `ip` must leave a card blank, never fail the whole dashboard.
function createStats({ fs = nodeFs, runCommand = () => '', statfs = nodeFs.statfsSync, userDir = '/mnt/wifi5', standIns = [], now = Date.now, random = Math.random } = {}) {
  let prev = null; // last /proc/stat sample, for the delta

  function cpuTimes() {
    return readText(fs, '/proc/stat')
      .split('\n')
      .filter((l) => /^cpu\d* /.test(l))
      .map((l) => l.trim().split(/\s+/).slice(1).map(Number));
  }

  // One percentage per core, then the overall figure last (the page labels the last bar "ALL").
  function cpuusage() {
    const now = cpuTimes();
    const before = prev || now;
    prev = now;
    const per = now.map((cur, i) => {
      const old = before[i] || cur;
      const total = cur.reduce((a, b) => a + b, 0) - old.reduce((a, b) => a + b, 0);
      const idle = cur[3] + (cur[4] || 0) - (old[3] + (old[4] || 0));
      return total > 0 ? Math.round(((total - idle) / total) * 100) : 0;
    });
    return per.length > 1 ? [...per.slice(1), per[0]] : per; // /proc/stat lists the overall line first
  }

  function cpuinfo() {
    const cores = readText(fs, '/proc/cpuinfo').split('\n').filter((l) => /^processor\s*:/.test(l)).length;
    const khz = (f) => Number(readText(fs, `/sys/devices/system/cpu/cpu0/cpufreq/${f}`)) || 0;
    return { length: cores, speed: { min: khz('cpuinfo_min_freq') / 1000, max: khz('cpuinfo_max_freq') / 1000 } };
  }

  function ram() {
    const kb = (key) => Number((new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(readText(fs, '/proc/meminfo')) || [])[1]) * 1024 || 0;
    return { total: kb('MemTotal'), free: kb('MemAvailable') || kb('MemFree') };
  }

  function disk(dir) {
    try {
      const s = statfs(dir);
      const size = s.blocks * s.bsize;
      return { size, used: size - s.bavail * s.bsize };
    } catch {
      return { size: 0, used: 0 };
    }
  }

  const temp = () => (Number(readText(fs, '/sys/class/thermal/thermal_zone0/temp')) || 0) / 1000;

  function system() {
    const model = readText(fs, '/proc/device-tree/model').replace(/\0/g, '').trim();
    const chip = (/^(?:Hardware|model name)\s*:\s*(.+)$/m.exec(readText(fs, '/proc/cpuinfo')) || [])[1] || '';
    return { model, system: chip.trim(), release: { target: process.arch } };
  }

  // `ip -s -j link show` as the string the page JSON.parses itself.
  // standIns: interface names this machine lacks but the pages expect (a development laptop has no eth0). Their
  // counters follow a drifting, bursty rate, so the traffic graph moves like a real WAN's instead of drawing one flat line.
  const sim = {};
  function simulate(n, t) {
    const x = sim[n] || (sim[n] = { t, rx: 5e8, tx: 1e8, rate: 150000, burst: 0 });
    const dt = Math.max(0, Math.min(10, t - x.t));
    x.t = t;
    x.rate = Math.max(8000, Math.min(600000, x.rate * (0.8 + random() * 0.45))); // a random walk, kept in range
    if (x.burst <= 0 && random() < 0.08) x.burst = 2 + Math.floor(random() * 4); // now and then a short download burst
    const boost = x.burst > 0 ? 2 + random() * 2 : 1;
    x.burst -= dt;
    x.rx += Math.round(x.rate * boost * dt);
    x.tx += Math.round(x.rate * 0.18 * (0.6 + random() * 0.8) * dt);
    return { rx: { bytes: x.rx, packets: Math.round(x.rx / 900) }, tx: { bytes: x.tx, packets: Math.round(x.tx / 700) } };
  }

  function interfaceInfo() {
    let text = '[]';
    try { text = runCommand(['ip', '-s', '-j', 'link', 'show']) || '[]'; } catch { /* no ip */ }
    if (!standIns.length) return text;
    let list = [];
    try { list = JSON.parse(text); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const t = now() / 1000;
    for (const n of standIns) {
      if (list.some((l) => l.ifname === n)) continue;
      list.push({ ifname: n, link_type: 'ether', operstate: 'UP', stats64: simulate(n, t) });
    }
    return JSON.stringify(list);
  }

  // What `ubus call system info` answers on OpenWrt, from /proc, for a host without ubus (a dev machine, CI).
  function systemInfo() {
    const up = Number(readText(fs, '/proc/uptime').split(' ')[0]) || 0;
    const load = readText(fs, '/proc/loadavg').split(' ').filter(Boolean).slice(0, 3).map((n) => Math.round(Number(n) * 65536) || 0);
    const { total, free } = ram();
    return { uptime: Math.round(up), localtime: Math.round(Date.now() / 1000), load, memory: { total, free } };
  }

  return {
    systemInfo,
    snapshot: () => ({ cpuusage: cpuusage(), cpuinfo: cpuinfo(), ram: ram(), storage: { root: disk('/'), user: disk(userDir) }, temp: temp(), system: system(), interfaceInfo: interfaceInfo() }),
  };
}

module.exports = { createStats };
