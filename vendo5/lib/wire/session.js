const crypto = require('node:crypto');

// In-memory admin sessions, keyed by the cookie id. A session is created on the first GET /admin,
// becomes "allowed" after a successful socket login, and expires one hour after that.
function createSessions({ now = Date.now, ttlMs = 3600000, max = 500 } = {}) {
  const map = new Map();

  const sweep = () => {
    const t = now();
    for (const [id, s] of map) if (s.expiresAt <= t) map.delete(id);
  };

  return {
    ttlSeconds: Math.floor(ttlMs / 1000),
    create() {
      sweep();
      // Anyone on the LAN can request /admin without a cookie; cap the table so that cannot grow it
      // without bound. Maps iterate in insertion order, so the first key is the oldest session.
      while (map.size >= max) map.delete(map.keys().next().value);
      const s = { id: crypto.randomBytes(24).toString('hex'), allowed: false, challenge: null, expiresAt: now() + ttlMs };
      map.set(s.id, s);
      return s;
    },
    get(id) {
      if (typeof id !== 'string' || id === '') return null;
      const s = map.get(id);
      if (!s) return null;
      if (s.expiresAt <= now()) {
        map.delete(id);
        return null;
      }
      return s;
    },
    allow(s) {
      s.allowed = true;
      s.expiresAt = now() + ttlMs;
    },
    destroy(id) {
      map.delete(id);
    },
    size() {
      sweep();
      return map.size;
    },
  };
}

module.exports = { createSessions };
