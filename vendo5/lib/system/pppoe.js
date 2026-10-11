const fs = require('node:fs');
const path = require('node:path');

// The machine side of PPPoE: the secrets file pppd reads, per-user rate files the ip-up hook reads, and the list of
// sessions the hook records. Everything is plain files so it works the same under test.
const toBits = (s) => { const m = /^(\d+)([KMGT])$/.exec(s); return m ? Number(m[1]) * { K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] : 0; };

function createPppoeSystem({ store, secretsFile, limitsDir, sessionsDir, runCommand, now = Date.now }) {
  const live = (a) => a.expiration > now();

  // chap-secrets: only accounts that have not expired may log in. Written atomically.
  function sync() {
    const accounts = Object.values(store.list());
    const lines = ['# written by vendo5, do not edit', ...accounts.filter(live).map((a) => `"${a.username}" * "${a.password.replace(/(["\\])/g, '\\$1')}" *`)];
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true, mode: 0o755 });
    fs.writeFileSync(secretsFile + '.tmp', lines.join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(secretsFile + '.tmp', secretsFile);
    fs.mkdirSync(limitsDir, { recursive: true });
    for (const f of fs.readdirSync(limitsDir)) if (!store.get(f)) fs.rmSync(path.join(limitsDir, f), { force: true });
    for (const a of accounts) fs.writeFileSync(path.join(limitsDir, a.username), `${toBits(a.upload)} ${toBits(a.download)}\n`);
  }

  // sessions the ip-up hook recorded: [{ username, ifname, remoteIP, mac, since }]
  function active() {
    let files = [];
    try { files = fs.readdirSync(sessionsDir); } catch { return []; }
    const out = [];
    for (const f of files) {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
        if (v && typeof v.username === 'string' && /^ppp\d+$/.test(f.replace(/\.json$/, ''))) out.push({ username: v.username, ifname: f.replace(/\.json$/, ''), remoteIP: String(v.remoteIP || ''), mac: String(v.mac || '').toLowerCase(), since: Number(v.since) || now() });
      } catch { /* a half-written record: skipped until the next look */ }
    }
    return out;
  }

  // Hang up a user's sessions: pppd ends when its interface's process is signalled.
  function disconnect(username) {
    let n = 0;
    for (const s of active().filter((x) => x.username === username)) {
      try { runCommand(['pkill', '-HUP', '-f', `pppd.* ${s.ifname}( |$)`]); } catch { /* already gone */ }
      fs.rmSync(path.join(sessionsDir, `${s.ifname}.json`), { force: true });
      n++;
    }
    return n;
  }

  // Run on a timer: accounts that expired lose their secret and any live session.
  function sweep() {
    sync();
    for (const s of active()) {
      const a = store.get(s.username);
      if (!a || !live(a)) disconnect(s.username);
    }
  }

  return { sync, active, disconnect, sweep };
}

module.exports = { createPppoeSystem, toBits };
