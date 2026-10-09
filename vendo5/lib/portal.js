const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PAY_INTENT_TTL_MS = 10000;
const THEME_DIR = path.join(__dirname, '..', 'public', 'theme');
const THEME_TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon' };

// Real markup/ids recovered from the original WiFi5-Soft client theme
// (legacy/wifi5-soft/frontend-decrypted/public/client/defualt-theme/global.js:
// creditbox, clientstatus), trimmed to what sub-project #2 actually has:
// one coin pin, one rate, no vouchers/extend/eload (out of scope per spec).
function pageShell(statusTitle, statusHtml, creditHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>WiFi5-Soft</title>
<link rel="icon" href="/theme/img/i.ico">
<link rel="stylesheet" href="/theme/css/materialdesignicons.min.css">
<link rel="stylesheet" href="/theme/css/vendor.bundle.base.css">
<link rel="stylesheet" href="/theme/css/style.css">
<link rel="stylesheet" href="/theme/css/toast.css">
<script src="/theme/js/jquery.min.js"></script>
<script src="/theme/js/toast.js"></script>
</head>
<body>
<div class="container-scroller">
<div class="container-fluid page-body-wrapper" style="padding-top:40px;">
<div class="main-panel" style="margin:auto;max-width:480px;">
<div class="content-wrapper">
<div class="text-center" style="margin-bottom:16px;"><img src="/theme/img/logo.png" style="max-width:160px;"></div>
<div class="card" style="min-height:86px;margin-bottom:10px;">
<h4 class="card-title" id="title-status" style="display:flex;border-bottom:1px solid;padding:5px;margin:5px 10px;">${statusTitle}</h4>
<div class="card-body" style="display:flex;padding:16px 20px;justify-content:space-around;">
<div style="margin-right:20px;width:65%;display:grid;justify-content:center;padding-left:15px;">
<div class="row" style="align-content:flex-end;"><div class="d-flex align-items-center align-self-start"><h3 class="mb-0 text-success" id="client-duration">${statusHtml}</h3></div></div>
<h6 class="text-muted font-weight-normal">Current Duration</h6>
</div>
</div>
</div>
<div class="card" style="min-height:86px;">
<div class="card-body" style="display:flex;padding:10px 20px;justify-content:space-around;">
<div style="margin-right:20px;width:75%;display:grid;justify-content:center;padding-left:15px;">
<div class="row" style="align-content:flex-end;"><div class="d-flex align-items-center align-self-start"><h3 class="mb-0 text-info" id="client-credit">${creditHtml}</h3></div></div>
</div>
<div id="insert-btn-parent" style="display:grid;align-items:center;">
<button id="client-insert-coin" class="btn btn-outline-warning btn-icon-text" style="height:auto;">
<i class="mdi mdi-coin btn-icon-prepend mdi-48px"></i>
<span id="insert1" class="d-inline-block text-left blink" style="margin:auto;font-size:18px;font-weight:bold;">INSERT COIN</span>
</button>
</div>
</div>
</div>
</div>
</div>
</div>
</div>
<script>
$('#client-insert-coin').on('click', function () {
  $.post('/api/pay-intent').done(function () { toastada.show('Insert your coin now.', 'info'); });
});
function poll() {
  $.getJSON('/api/status').done(function (s) {
    $('#title-status').text(s.active ? 'Online' : 'Offline');
    $('#client-duration').text(s.active ? Math.floor(s.remainingSeconds / 60) + 'm ' + (s.remainingSeconds % 60) + 's' : '00:00');
    $('#client-credit').text(s.active ? 'Connected' : 'Insert coin to continue');
  });
}
setInterval(poll, 2000);
</script>
</body>
</html>`;
}

function landingPage() {
  return pageShell('Offline', '00:00', 'Insert coin to continue');
}

function onlinePage(remainingSeconds) {
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  return pageShell('Online', `${mins}m ${secs}s`, 'Connected');
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

function createServer({ session, arp, ratePesosPerMinute }) {
  let pendingPayer = null; // { mac, at }

  // Ruling (code-review fix pass): don't clear on a successful consume —
  // touch (refresh) the window instead, so back-to-back coin pulses for
  // the same payer (plan's own Review Focus #1) keep finding them. Only
  // an actual TTL lapse with no intervening pulse frees the slot.
  function consumePendingPayer(now = Date.now()) {
    if (!pendingPayer) return null;
    const { mac, at } = pendingPayer;
    if (now - at > PAY_INTENT_TTL_MS) {
      pendingPayer = null;
      return null;
    }
    pendingPayer = { mac, at: now };
    return mac;
  }

  // A different MAC may not steal an already-active pending-payer slot;
  // the same MAC always refreshes its own window.
  function setPendingPayer(mac, now = Date.now()) {
    if (pendingPayer && pendingPayer.mac !== mac && now - pendingPayer.at <= PAY_INTENT_TTL_MS) {
      return false;
    }
    pendingPayer = { mac, at: now };
    return true;
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
    const mac = clientMac(req);

    if (req.method === 'GET' && req.url.startsWith('/theme/')) {
      serveThemeFile(req.url, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/pay-intent') {
      const ok = mac ? setPendingPayer(mac) : false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
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
