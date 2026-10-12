const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PAY_INTENT_TTL_MS = 10000;
const THEME_DIR = path.join(__dirname, '..', 'public', 'theme');
const THEME_TYPES = { '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };

function shell(title, body, script = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/theme/favicon.png">
<link rel="stylesheet" href="/theme/vendo.css">
</head>
<body>
${body}
<script>
var toastada = { info: toast, success: toast, warning: toast, error: toast };
function toast(msg) {
  var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3000);
}
function post(url, data) {
  // final-review fix: a 401/404/500 response has an empty body; the old
  // r.json() threw on it (unhandled rejection) for every caller. Read as
  // text and parse defensively so callers always get an object back.
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }).then(function (r) {
    return r.text().then(function (t) {
      var parsed = {}; try { parsed = t ? JSON.parse(t) : {}; } catch (e) {}
      return parsed;
    });
  });
}
${script}
</script>
</body>
</html>`;
}

function clientPage() {
  return shell('MekusMekus WiFi', `<div class="wrap">
<img class="banner" src="/theme/banner.jpg" alt="MekusMekus Labs">
<div class="card">
<h2 id="title-status">Offline</h2>
<div class="big" id="client-duration">00:00</div>
<div class="state" id="client-credit">Insert coin to continue</div>
</div>
<div class="card"><button id="client-insert-coin">INSERT COIN</button></div>
<div class="card">
<input id="voucher-code" placeholder="Voucher code" maxlength="32" autocomplete="off" autocapitalize="characters">
<button id="voucher-redeem">USE VOUCHER</button>
<button id="client-pause" style="display:none">PAUSE</button>
</div>
<div class="card" id="chat-card" style="display:none">
<div id="chat-log" style="max-height:160px;overflow:auto;text-align:left;font-size:13px"></div>
<input id="chat-text" placeholder="Message the owner" maxlength="500" autocomplete="off">
<button id="chat-send">SEND</button>
</div>
<div class="tag">They Invent. We Reinvent.</div>
</div>`, `
document.getElementById('client-insert-coin').onclick = function () {
  post('/api/pay-intent').then(function () { toastada.info('Insert your coin now.'); });
};
document.getElementById('voucher-redeem').onclick = function () {
  var c = document.getElementById('voucher-code');
  post('/api/redeem', { code: c.value }).then(function (r) {
    if (r.ok) { c.value = ''; toastada.success('Voucher accepted.'); } else toastada.error(r.message || 'Error');
    poll();
  });
};
document.getElementById('client-pause').onclick = function () {
  var paused = this.dataset.paused === '1';
  post(paused ? '/api/resume' : '/api/pause').then(function (r) { if (!r.ok) toastada.error(r.message || 'Error'); poll(); });
};
function pollChat() {
  fetch('/api/chat').then(function (r) { return r.json(); }).then(function (d) {
    var card = document.getElementById('chat-card'); card.style.display = '';
    var log = document.getElementById('chat-log'); log.textContent = '';
    Object.keys(d.messages || {}).sort(function (a, b) { return a - b; }).forEach(function (k) {
      var m = d.messages[k], div = document.createElement('div');
      div.textContent = (m.sender === 'admin' ? 'Owner: ' : 'You: ') + (m.type === 'text' ? m.message.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : '(emoji)');
      log.appendChild(div);
    });
    log.scrollTop = log.scrollHeight;
  }).catch(function () {});
}
document.getElementById('chat-send').onclick = function () {
  var t = document.getElementById('chat-text');
  if (t.value) post('/api/chat', { message: t.value }).then(function () { t.value = ''; pollChat(); });
};
function poll() {
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    var m = Math.floor(s.remainingSeconds / 60), sec = s.remainingSeconds % 60;
    var has = s.active || s.paused;
    document.getElementById('title-status').textContent = s.paused ? 'Paused' : s.active ? 'Online' : 'Offline';
    document.getElementById('title-status').className = s.active ? 'on' : '';
    document.getElementById('client-duration').textContent = has ? m + 'm ' + sec + 's' : '00:00';
    document.getElementById('client-credit').textContent = s.paused ? 'Paused, time is saved' : s.active ? 'Connected' : 'Insert coin or enter a voucher';
    var pb = document.getElementById('client-pause');
    pb.style.display = s.pausable && has ? '' : 'none';
    pb.dataset.paused = s.paused ? '1' : '0';
    pb.textContent = s.paused ? 'RESUME' : 'PAUSE';
  });
}
poll(); setInterval(poll, 2000); pollChat(); setInterval(pollChat, 5000);`);
}

function serveThemeFile(urlPath, res) {
  const rel = urlPath.replace(/^\/theme\//, '');
  const ext = path.extname(rel);
  const filePath = path.join(THEME_DIR, rel);
  // shortcut: no path-traversal check beyond extname allow-list; theme/
  // only ever serves our own static assets, no user input reaches rel.
  if (!THEME_TYPES[ext] || !filePath.startsWith(THEME_DIR)) { res.writeHead(404).end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': THEME_TYPES[ext] });
    res.end(data);
  });
}

const MAX_BODY = 4096;

// A small JSON body, never more than MAX_BODY bytes; anything else (not JSON, not an object) is {}.
function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { if (body.length < MAX_BODY) body += c; });
    req.on('end', () => {
      let v;
      try { v = JSON.parse(body || '{}'); } catch { v = {}; }
      resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    });
    req.on('error', () => resolve({}));
  });
}

function reply(res, r) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(r));
}

function createServer({ session, arp, ratePesosPerMinute, adminRoutes, money, chat, portal, subvendo }) {
  const pending = new Map(); // vendo id -> { mac, at, ttl }: who is inserting coins there

  // Ruling (code-review fix pass): don't clear on a successful consume —
  // touch (refresh) the window instead, so back-to-back coin pulses for
  // the same payer (plan's own Review Focus #1) keep finding them. Only
  // an actual TTL lapse with no intervening pulse frees the slot.
  function consumePendingPayer(now = Date.now(), vendo = 'main') {
    const p = pending.get(vendo);
    if (!p) return null;
    if (now - p.at > p.ttl) {
      pending.delete(vendo);
      return null;
    }
    pending.set(vendo, { ...p, at: now });
    return p.mac;
  }

  // Is someone waiting to pay at this vendo? A look only: the window is not refreshed.
  const hasPendingPayer = (now = Date.now(), vendo = 'main') => { const p = pending.get(vendo); return !!p && now - p.at <= p.ttl; };

  // A different MAC may not steal an already-active pending-payer slot;
  // the same MAC always refreshes its own window.
  function setPendingPayer(mac, now = Date.now(), ttl = PAY_INTENT_TTL_MS, vendo = 'main') {
    const p = pending.get(vendo);
    if (p && p.mac !== mac && now - p.at <= p.ttl) return false;
    pending.set(vendo, { mac, at: now, ttl });
    return true;
  }

  // The popup closed: the slot stays theirs graceMs more (a coin already falling), then the next phone may tap.
  function releasePendingPayer(mac, now = Date.now(), graceMs = 0, vendo = 'main') {
    const p = pending.get(vendo);
    if (p && p.mac === mac) pending.set(vendo, { mac, at: now, ttl: graceMs });
  }

  function clientMac(req) {
    // dual-stack server binds to '::' by default; real IPv4 clients arrive
    // as '::ffff:a.b.c.d' and `ip neigh show` has no entry for that form.
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return arp.ipToMac(ip);
  }

  function remainingSecondsFor(mac, now = Date.now()) {
    const sess = session.getSession(mac);
    if (!sess) return 0;
    return Math.max(0, Math.round((sess.expiresAt - now) / 1000));
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/theme/')) {
      serveThemeFile(req.url, res);
      return;
    }

    // the customer portal's theme files live in the selected theme's folder
    if (portal && req.url.startsWith('/client/theme/')) {
      req.url = req.url.replace('/client/theme/', `/client/${portal.themeDir()}/`);
      if (portal.serveStatic(req, res)) return;
    }

    // Sub-vendo ESP8266s (signed, see lib/subvendo.js); before clientMac() since the handler looks the ESP up itself.
    if (subvendo && req.method === 'POST' && req.url === '/subvendo/poll') {
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      readJsonBody(req).then((b) => reply(res, subvendo(b, ip)));
      return;
    }

    // /admin and the admin frontend's static files; before clientMac(), which shells out to `ip neigh`.
    if (adminRoutes && adminRoutes(req, res)) return;

    const mac = clientMac(req);

    if (req.method === 'POST' && req.url === '/api/pay-intent') {
      const ok = mac && !(money && money.blocked(mac)) ? setPendingPayer(mac) : false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
      return;
    }

    // Voucher, pause and resume go through the money module; without it these routes do not exist.
    if (money && req.method === 'POST' && req.url === '/api/redeem') {
      readJsonBody(req).then((b) => reply(res, money.redeemVoucher(mac, b.code)));
      return;
    }
    // The portal page's own script keeps the resume code in the browser; a phone back with a new random MAC
    // posts it and gets its time back without typing anything (the Logs-page code stays the manual way).
    if (money && req.method === 'POST' && req.url === '/api/resume-code') {
      readJsonBody(req).then((b) => {
        const live = (m) => { const s = m && session.getSession(m); return s && (s.paused || s.expiresAt > Date.now()) ? s : null; };
        let moved = false;
        if (mac && !live(mac) && typeof b.code === 'string' && /^[A-Z0-9]{8}$/.test(b.code)) {
          const r = money.moveSession(mac, b.code);
          moved = !!r && r.ok;
        }
        const s = live(mac);
        reply(res, { code: (s && s.resumeCode) || '', moved });
      });
      return;
    }
    if (money && req.method === 'POST' && (req.url === '/api/pause' || req.url === '/api/resume')) {
      reply(res, req.url === '/api/pause' ? money.pause(mac) : money.resume(mac));
      return;
    }

    // The client's side of Chat: read the conversation, send a message.
    if (chat && mac && req.method === 'GET' && req.url === '/api/chat') {
      reply(res, { messages: chat.history(mac) });
      chat.seen(mac);
      return;
    }
    if (chat && req.method === 'POST' && req.url === '/api/chat') {
      readJsonBody(req).then((b) => reply(res, { ok: !!mac && typeof b.message === 'string' && !!chat.send(mac, b.message) }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      const sess = mac ? session.getSession(mac) : null;
      const paused = !!sess && !!sess.paused;
      const active = !!mac && session.isActive(mac);
      const remaining = paused ? Math.round(sess.remainingMs / 1000) : active ? remainingSecondsFor(mac) : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active, paused, pausable: !!sess && sess.type === 'pausable', pauseLeft: sess && sess.pauselimit, remainingSeconds: remaining }));
      return;
    }

    // The original customer portal: its theme's files under /client/theme/, everything else is the page itself
    // (captive-portal probes land here on any path, so any other GET answers with the page).
    if (portal && (req.method === 'GET' || req.method === 'HEAD')) {
      const page = new URL(req.url, 'http://x').searchParams.get('page');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(portal.render(page));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(clientPage());
  });

  return { server, consumePendingPayer, setPendingPayer, hasPendingPayer, releasePendingPayer };
}

module.exports = { createServer };
