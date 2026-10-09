const http = require('node:http');

const PAY_INTENT_TTL_MS = 10000;

function createServer({ session, arp, ratePesosPerMinute }) {
  let pendingPayer = null; // { mac, at }

  function consumePendingPayer(now = Date.now()) {
    if (!pendingPayer) return null;
    const { mac, at } = pendingPayer;
    pendingPayer = null;
    return now - at <= PAY_INTENT_TTL_MS ? mac : null;
  }

  function clientMac(req) {
    const ip = req.socket.remoteAddress;
    return arp.ipToMac(ip);
  }

  function landingPage() {
    return '<html><body><h1>Insert coin to continue</h1></body></html>';
  }

  function onlinePage(remainingSeconds) {
    return `<html><body><h1>You're online</h1><p>${remainingSeconds}s remaining</p></body></html>`;
  }

  function remainingSecondsFor(mac, now = Date.now()) {
    const sess = session.getSession(mac);
    if (!sess) return 0;
    return Math.max(0, Math.round((sess.expiresAt - now) / 1000));
  }

  const server = http.createServer((req, res) => {
    const mac = clientMac(req);

    if (req.method === 'POST' && req.url === '/api/pay-intent') {
      if (mac) pendingPayer = { mac, at: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      const active = !!mac && session.isActive(mac);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active, remainingSeconds: active ? remainingSecondsFor(mac) : 0 }));
      return;
    }

    const active = !!mac && session.isActive(mac);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(active ? onlinePage(remainingSecondsFor(mac)) : landingPage());
  });

  return { server, consumePendingPayer };
}

module.exports = { createServer };
