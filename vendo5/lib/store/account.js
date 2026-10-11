const fs = require('node:fs');
const path = require('node:path');

const FACTORY = { username: 'admin', password: 'admin' };

// The admin credential. Plaintext on purpose: the original login hashes the typed password with a
// per-login token in the browser, so the server must know the password to recompute the hash.
// The file is mode 0600 and written atomically.
function createAccountStore(file) {
  let main = { ...FACTORY };

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ main }) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // the umask can only remove bits, but be explicit
    fs.renameSync(tmp, file);
  }

  // Returns true when the account had to be (re)created with the factory default.
  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.main && typeof parsed.main.username === 'string' && typeof parsed.main.password === 'string') {
        main = { username: parsed.main.username, password: parsed.main.password };
        return false;
      }
    } catch {
      // missing or corrupt: fall through to the factory default
    }
    main = { ...FACTORY };
    save();
    return true;
  }

  const get = () => ({ ...main });
  const isFactoryDefault = () => main.username === FACTORY.username && main.password === FACTORY.password;

  // The shell sends {username, cnewpass, oldtpass}; it validates length and emoji itself, the
  // server only checks the old password and refuses empty values.
  function change({ username, oldPassword, newPassword }) {
    if (oldPassword !== main.password) return false;
    if (typeof newPassword !== 'string' || newPassword === '' || typeof username !== 'string' || username === '') return false;
    main = { username, password: newPassword };
    save();
    return true;
  }

  function reset() {
    main = { ...FACTORY };
    save();
  }

  return { load, get, isFactoryDefault, change, reset };
}

module.exports = { createAccountStore, FACTORY };
