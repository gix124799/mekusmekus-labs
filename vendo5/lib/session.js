const fs = require('node:fs');

function createSessionStore(filePath) {
  let sessions = {}; // mac -> { mac, creditPesos, expiresAt }

  function load(now = Date.now()) {
    sessions = {};
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // missing file: start empty, not an error
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt file: start empty, not an error
    }
    for (const [mac, sess] of Object.entries(parsed)) {
      if (sess.expiresAt > now) sessions[mac] = sess;
    }
  }

  function save() {
    fs.mkdirSync(require('node:path').dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessions));
    fs.renameSync(tmp, filePath); // atomic: a crash leaves the old file or the new one, never a half-write
  }

  function getSession(mac) {
    return sessions[mac];
  }

  function isActive(mac, now = Date.now()) {
    const sess = sessions[mac];
    return !!sess && sess.expiresAt > now;
  }

  function addCredit(mac, pesos, ratePesosPerMinute, now = Date.now()) {
    const existing = sessions[mac];
    const minutes = pesos / ratePesosPerMinute;
    if (existing && existing.expiresAt > now) {
      existing.creditPesos += pesos;
      existing.expiresAt += minutes * 60000;
    } else {
      sessions[mac] = { mac, creditPesos: pesos, expiresAt: now + minutes * 60000 };
    }
    return sessions[mac];
  }

  function expireDue(now = Date.now()) {
    const due = [];
    for (const [mac, sess] of Object.entries(sessions)) {
      if (sess.expiresAt <= now) due.push(mac);
    }
    for (const mac of due) delete sessions[mac];
    return due;
  }

  function revoke(mac) {
    if (!(mac in sessions)) return false;
    delete sessions[mac];
    return true;
  }

  function all() {
    return { ...sessions };
  }

  return { load, save, addCredit, getSession, isActive, expireDue, revoke, all };
}

module.exports = { createSessionStore };
