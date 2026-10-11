const { Server } = require('socket.io');

const WINDOW_MS = 10000;
const MAX_EVENTS = 40; // per socket per window: the portal's sockets are anonymous, so they are rate limited

// The customer portal's socket (socket.io's default path, as the original page connects). A client is the device
// behind the socket's address: identify(socket) -> its MAC (or null). events: { '<id>': { handler(payload, ctx), fallback } }.
function attachPortal(httpServer, { events, identify, log = () => {}, now = Date.now, resolve = () => null, plain = (x) => x }) {
  const io = new Server({ serveClient: false, transports: ['websocket', 'polling'], maxHttpBufferSize: 65536 });
  io.attach(httpServer);

  io.use((socket, next) => {
    let mac = null;
    try { mac = identify(socket); } catch { /* an unknown device is still served the page; its events answer "unknown" */ }
    socket.data.mac = mac ? String(mac).toLowerCase() : null;
    next();
  });

  io.on('connection', (socket) => {
    // a page asking for something we do not know (another theme's protocol) is worth seeing in the log
    socket.onAny((ev, ...a) => { if (!events[ev] && !resolve(ev, socket)) log('warn', 'portal: event with no handler', { ev: String(ev).slice(0, 60), plain: plain(String(ev)).slice(0, 60), args: JSON.stringify(a.filter((x) => typeof x !== 'function')).slice(0, 200), auth: JSON.stringify(socket.handshake.auth).slice(0, 80) }); });
    let windowStart = now();
    let count = 0;
    const bind = (id, def) => {
      socket.on(id, async (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
        if (now() - windowStart > WINDOW_MS) { windowStart = now(); count = 0; }
        if (++count > MAX_EVENTS) return; // flooding: dropped without an answer
        try {
          ack(await def.handler(args[0], { mac: socket.data.mac, socket, ip: String(socket.handshake.address || '').replace(/^::ffff:/, '') }));
        } catch (e) {
          log('error', `portal handler ${id} failed`, { error: e && e.message });
          ack(def.fallback);
        }
      });
    };
    for (const [id, def] of Object.entries(events)) bind(id, def);
    // another theme's events (its own naming) are looked up the first time they arrive
    const bound = new Set();
    socket.onAny((ev) => { if (events[ev] || bound.has(ev)) return; const def = resolve(ev, socket); if (def) { bound.add(ev); bind(ev, def); } });
  });

  // Tell every open page of one device (a coin was inserted, an admin wrote in the chat...).
  io.pushTo = (mac, event, payload) => {
    for (const sock of io.sockets.sockets.values()) if (sock.data.mac === String(mac).toLowerCase()) sock.emit(event, payload);
  };
  io.pushAll = (event, payload) => io.emit(event, payload);
  return io;
}

module.exports = { attachPortal, MAX_EVENTS, WINDOW_MS };
