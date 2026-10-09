const crypto = require('node:crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function createAdminAuth({ username, passwordHash }) {
  const tokens = new Set(); // active session tokens; in-memory, cleared on restart

  function login(u, p) {
    if (u !== username || hashPassword(p) !== passwordHash) return null;
    const token = crypto.randomBytes(24).toString('hex');
    tokens.add(token);
    return token;
  }

  function verify(token) {
    return !!token && tokens.has(token);
  }

  function logout(token) {
    tokens.delete(token);
  }

  return { login, verify, logout };
}

module.exports = { createAdminAuth, hashPassword };
