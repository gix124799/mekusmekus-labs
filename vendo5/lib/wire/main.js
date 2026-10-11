const crypto = require('node:crypto');

// The browser hashes with the vendor's md5.js, which feeds each character's low 8 bits to MD5 (not
// UTF-8). 'latin1' is exactly that, so a password such as "päss" or "パス" hashes identically on both
// sides. Hashing UTF-8 here would lock out any admin whose password has a non-ASCII character.
const md5 = (s) => crypto.createHash('md5').update(Buffer.from(s, 'latin1')).digest('hex');
const CHALLENGE_WINDOW_MS = 3000;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The browser splits the token with these exact expressions; for an odd length (1/2 is fractional)
// substring() truncates, so both halves are computed the same way here.
function splitToken(token) {
  const mid = (token.length - 1) / 2;
  return [token.substring(0, mid), token.substring(mid, token.length)];
}

// Handlers for the login page (@main-*). Each is (payload, ctx) => reply; ctx = { session, ip }.
function createMainHandlers({ account, sessions, licence, mainlog, version, now = Date.now, makeToken = () => crypto.randomBytes(16).toString('hex') }) {
  const log = (text) => { if (mainlog) mainlog.write('system', text); };

  return {
    // The login page asks for a token; the browser hashes the typed credentials with its two halves.
    '@main-48931': {
      guard: false,
      fallback: '',
      handler(_payload, ctx) {
        if (!ctx.session) return '';
        const token = makeToken();
        ctx.session.challenge = { token, at: now() };
        return token;
      },
    },

    '@main-66589': {
      guard: false,
      fallback: { login: false },
      handler(payload, ctx) {
        const p = payload && typeof payload === 'object' ? payload : {};
        const name = typeof p.uname === 'string' ? p.uname : '';
        const session = ctx.session;
        const ch = session && session.challenge;
        if (session) session.challenge = null; // one attempt per token, pass or fail
        let ok = false;
        if (ch && now() - ch.at < CHALLENGE_WINDOW_MS) {
          const [a, b] = splitToken(ch.token);
          const acc = account.get();
          ok = safeEqual(p.username, md5(a + acc.username.toLowerCase().replace(/\s/g, ''))) && safeEqual(p.password, md5(b + acc.password.replace(/\s/g, '')));
        }
        if (ok) {
          sessions.allow(session);
          log(`Admin Success Login: user ${name} from ${ctx.ip}`);
        } else {
          log(`Admin Failed Login: user ${name} invalid user or password from ${ctx.ip}`);
        }
        return { login: ok };
      },
    },

    // Shown on the login page as "Version: x" and "Code: y".
    '@main-66322': {
      guard: false,
      fallback: {},
      handler: () => ({ version, prefix: licence.deviceId().slice(0, 8) }),
    },

    // The shell's change-password dialog sends {username, cnewpass, oldtpass} and shows the reply text.
    '@main-84472': {
      guard: true,
      fallback: 'Error',
      handler(payload) {
        const p = payload && typeof payload === 'object' ? payload : {};
        const ok = account.change({ username: p.username, oldPassword: p.oldtpass, newPassword: p.cnewpass });
        if (ok) log('Admin account changed');
        return ok ? 'Success' : 'Invalid Password';
      },
    },
  };
}

module.exports = { createMainHandlers, splitToken, md5, CHALLENGE_WINDOW_MS };
