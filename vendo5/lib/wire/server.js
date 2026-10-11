const { Server } = require('socket.io');
const ss = require('socket.io-stream');

const COOKIE = 'vendo5_sid';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function ipOf(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  const raw = (fwd ? String(fwd).split(',')[0].trim() : socket.handshake.address) || '';
  return raw.replace(/^::ffff:/, '');
}

// Mounts socket.io at `path` (/admin, or /reseller for the reseller portal: the paths the original frontends connect to) and routes each event id
// through the table. events: { '<id>': { handler(payload, ctx), guard, fallback } }.
//   guard: the session must be logged in and unexpired, else the socket is disconnected and the
//          handler never runs (the original's per-event expiry check).
//   fallback: what the client is answered if the handler throws (handlers never throw into the socket).
function attachWire(httpServer, { events, sessions, log = () => {}, cookieName = COOKIE, path = '/admin', landing = '/admin?page=dashboard' }) {
  const io = new Server({ path, serveClient: false, transports: ['websocket', 'polling'], maxHttpBufferSize: 262144 });
  io.attach(httpServer);

  // engine.io now owns every request under "/admin/". The original nginx redirected a bare "/admin/"
  // (no EIO query) to the dashboard; do the same before engine.io can answer it with a 400.
  const wired = httpServer.listeners('request').slice();
  httpServer.removeAllListeners('request');
  httpServer.on('request', (req, res) => {
    if (req.url.startsWith(path + '/') && !/[?&]EIO=/.test(req.url)) {
      res.writeHead(302, { Location: landing }).end();
      return;
    }
    for (const l of wired) l.call(httpServer, req, res);
  });

  // Tell every socket whose session is still logged in (chat messages must never reach the login page's sockets).
  io.pushAuthed = (event, payload) => {
    for (const sock of io.sockets.sockets.values()) {
      const s = sessions.get(sock.data.sid);
      if (s && s.allowed) sock.emit(event, payload);
    }
  };

  io.use((socket, next) => {
    socket.data.sid = parseCookies(socket.request.headers.cookie)[cookieName] || '';
    next();
  });

  io.on('connection', (socket) => {
    for (const [id, def] of Object.entries(events)) {
      if (def.stream) {
        // an upload arrives as (stream, data, ack) through socket.io-stream
        ss(socket).on(id, async (stream, data, cb) => {
          const ack = typeof cb === 'function' ? cb : () => {};
          const session = sessions.get(socket.data.sid);
          if (def.guard && !(session && session.allowed)) { stream.resume(); socket.disconnect(true); return; }
          try {
            ack(await def.handler({ stream, data }, { session, socket, ip: ipOf(socket) }));
          } catch (e) {
            log('error', `wire handler ${id} failed`, { error: e && e.message });
            stream.resume();
            ack(def.fallback);
          }
        });
        continue;
      }
      socket.on(id, async (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
        const session = sessions.get(socket.data.sid); // resolved per event so an expiry takes effect at once
        if (def.guard && !(session && session.allowed)) {
          socket.disconnect(true);
          return;
        }
        try {
          ack(await def.handler(args[0], { session, socket, ip: ipOf(socket) }));
        } catch (e) {
          log('error', `wire handler ${id} failed`, { error: e && e.message });
          ack(def.fallback);
        }
      });
    }
  });

  return io;
}

module.exports = { attachWire, parseCookies, ipOf, COOKIE };
