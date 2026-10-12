const fs = require('node:fs');
const crypto = require('node:crypto');

// A code the customer can type on a phone that changed its MAC: no 0/O/1/I to misread.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

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
      if (!live(sess, now)) continue;
      if (!sess.resumeCode) sess.resumeCode = newCode(); // saved before resume codes existed
      sessions[mac] = sess;
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
      sessions[mac] = { mac, creditPesos: pesos, expiresAt: now + minutes * 60000, startedAt: now, resumeCode: newCode() };
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
    const s = fresh ? { mac, creditPesos: 0, expiresAt: now, startedAt: now, type: meta.type || 'consumable', resumeCode: newCode() } : cur;
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
  // force (admin): any live session, and no pause is spent.
  function pause(mac, now = Date.now(), { force = false } = {}) {
    const s = sessions[mac];
    if (!s || !live(s, now) || s.paused) return { ok: false, reason: 'No active session' };
    if (!force && s.type !== 'pausable') return { ok: false, reason: 'This session cannot be paused' };
    if (!force && s.pauselimit !== undefined && s.pauselimit <= 0) return { ok: false, reason: 'No pauses left' };
    s.remainingMs = Math.max(0, s.expiresAt - now);
    s.paused = true;
    if (!force && s.pauselimit !== undefined) s.pauselimit -= 1;
    return { ok: true, session: s };
  }

  function resume(mac, now = Date.now()) {
    const s = sessions[mac];
    if (!s || !s.paused || !live(s, now)) return { ok: false, reason: 'Not paused' };
    if (s.outage) return { ok: false, reason: 'No internet right now, your time is saved' }; // the watchdog thaws it
    s.expiresAt = now + s.remainingMs;
    delete s.paused;
    delete s.remainingMs;
    return { ok: true, session: s };
  }

  // Internet outage: every running session stops its clock like a pause, marked so thaw resumes only these.
  function freeze(now = Date.now()) {
    const macs = [];
    for (const [mac, s] of Object.entries(sessions)) {
      if (s.paused || !live(s, now)) continue;
      s.remainingMs = Math.max(0, s.expiresAt - now);
      s.paused = true;
      s.outage = true;
      macs.push(mac);
    }
    return macs;
  }

  function thaw(now = Date.now()) {
    const macs = [];
    for (const [mac, s] of Object.entries(sessions)) {
      if (!s.outage) continue;
      s.expiresAt = now + s.remainingMs;
      delete s.paused;
      delete s.remainingMs;
      delete s.outage;
      macs.push(mac);
    }
    return macs;
  }

  // The live session a resume code (or the voucher code it runs) belongs to.
  function findByCode(code, now = Date.now()) {
    for (const [mac, s] of Object.entries(sessions)) {
      if (live(s, now) && (s.resumeCode === code || s.code === code)) return mac;
    }
    return null;
  }

  // A phone that came back with a new MAC: the whole session goes with it.
  function move(from, to, now = Date.now()) {
    const s = sessions[from];
    if (from === to || !s || !live(s, now)) return false;
    if (sessions[to] && live(sessions[to], now)) return false;
    sessions[to] = { ...s, mac: to };
    delete sessions[from];
    return true;
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

  return { load, save, addCredit, addTime, pause, resume, freeze, thaw, findByCode, move, restore, extend, getSession, isActive, expireDue, revoke, all };
}

module.exports = { createSessionStore };
