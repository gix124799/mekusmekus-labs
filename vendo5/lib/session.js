const fs = require('node:fs');

function createSessionStore(filePath) {
  let sessions = {}; // mac -> { mac, creditPesos, expiresAt, startedAt }

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
      if (live(sess, now)) sessions[mac] = sess;
    }
  }

  // A paused session keeps its frozen remainingMs; only a passed validity window ends it.
  const live = (sess, now) => (sess.validityEnd && sess.validityEnd <= now ? false : sess.paused ? true : sess.expiresAt > now);

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
    return !!sess && !sess.paused && live(sess, now);
  }

  function addCredit(mac, pesos, ratePesosPerMinute, now = Date.now()) {
    const existing = sessions[mac];
    const minutes = pesos / ratePesosPerMinute;
    if (existing && existing.paused) {
      existing.creditPesos += pesos;
      existing.remainingMs += minutes * 60000;
    } else if (existing && existing.expiresAt > now) {
      existing.creditPesos += pesos;
      existing.expiresAt += minutes * 60000;
    } else {
      sessions[mac] = { mac, creditPesos: pesos, expiresAt: now + minutes * 60000, startedAt: now };
    }
    return sessions[mac];
  }

  // Admin "extend": more time, no more credit. Only a live session can be extended.
  function extend(mac, ms, now = Date.now()) {
    const sess = sessions[mac];
    if (!sess || !live(sess, now) || !Number.isFinite(ms) || ms <= 0) return null;
    if (sess.paused) sess.remainingMs += ms;
    else sess.expiresAt += ms;
    return sess;
  }

  function expireDue(now = Date.now()) {
    const due = [];
    for (const [mac, sess] of Object.entries(sessions)) {
      if (!live(sess, now)) due.push(mac);
    }
    for (const mac of due) delete sessions[mac];
    return due;
  }

  // Time from a voucher or the admin (no coin): a new session, or more time on a live or paused one.
  // meta: { price, code, type, upload, download, max_data_limit, pauselimit, validityHours, notsametype }
  function addTime(mac, ms, meta = {}, now = Date.now()) {
    const cur = sessions[mac];
    const fresh = !cur || !live(cur, now);
    const s = fresh ? { mac, creditPesos: 0, expiresAt: now, startedAt: now, type: meta.type || 'consumable' } : cur;
    if (s.paused) s.remainingMs += ms;
    else s.expiresAt = (fresh ? now : s.expiresAt) + ms;
    s.creditPesos += meta.price || 0;
    s.duration = (fresh ? 0 : s.duration || 0) + Math.round(ms / 1000);
    for (const k of ['code', 'upload', 'download', 'max_data_limit', 'pauselimit', 'notsametype']) if (meta[k] !== undefined) s[k] = meta[k];
    if (meta.validityHours > 0 && !s.validityEnd) s.validityEnd = now + meta.validityHours * 3600000;
    sessions[mac] = s;
    return s;
  }

  // Pause freezes the remaining time; only a pausable session with pauses left can pause.
  function pause(mac, now = Date.now()) {
    const s = sessions[mac];
    if (!s || !live(s, now) || s.paused) return { ok: false, reason: 'No active session' };
    if (s.type !== 'pausable') return { ok: false, reason: 'This session cannot be paused' };
    if (s.pauselimit !== undefined && s.pauselimit <= 0) return { ok: false, reason: 'No pauses left' };
    s.remainingMs = Math.max(0, s.expiresAt - now);
    s.paused = true;
    if (s.pauselimit !== undefined) s.pauselimit -= 1;
    return { ok: true, session: s };
  }

  function resume(mac, now = Date.now()) {
    const s = sessions[mac];
    if (!s || !s.paused || !live(s, now)) return { ok: false, reason: 'Not paused' };
    s.expiresAt = now + s.remainingMs;
    delete s.paused;
    delete s.remainingMs;
    return { ok: true, session: s };
  }

  // Undo helper for a failed firewall call: put a session back exactly as it was (null removes it).
  function restore(mac, snapshot) {
    if (snapshot) sessions[mac] = snapshot;
    else delete sessions[mac];
  }

  function revoke(mac) {
    if (!(mac in sessions)) return false;
    delete sessions[mac];
    return true;
  }

  function all() {
    return { ...sessions };
  }

  return { load, save, addCredit, addTime, pause, resume, restore, extend, getSession, isActive, expireDue, revoke, all };
}

module.exports = { createSessionStore };
