const { enc, dec } = require('./themecipher');

// The React theme's side of the portal socket. Its event names are enc(<name>), the first one enc(session id).
// resolve(ev, socket) -> a handler definition for that event, or null when it is not one we serve.
function createThemeResolver({ handlers, log = () => {} }) {
  return {
    plain: dec,
    resolve(ev, socket) {
      const id = String((socket.handshake.auth || {}).id || '');
      const name = dec(ev);
      const h = ev === enc(id) ? handlers.handshake : handlers[name];
      return h || null;
    },
  };
}

module.exports = { createThemeResolver };
