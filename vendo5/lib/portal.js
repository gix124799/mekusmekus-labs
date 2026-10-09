const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PAY_INTENT_TTL_MS = 10000;
const THEME_DIR = path.join(__dirname, '..', 'public', 'theme');
const THEME_TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon' };

// Full real page structure, verbatim from the decrypted WiFi5-Soft client
// theme (legacy/wifi5-soft/frontend-decrypted/public/client/defualt-theme/
// index.html) — a hand-trimmed version broke the real CSS's layout
// assumptions (sidebar/navbar/footer missing while their classes
// (container-scroller/main-panel/content-wrapper) stayed, clipping
// content). Dropped only what's genuinely unrecoverable or unused:
// socket.io (no realtime backend), jquery.flot (no bandwidth graph),
// client/script/{tools,chat,*}.js (empty/obfuscated in the original),
// and the {2}/{4} license-injection placeholders.
function clientPage() {
  return `<!DOCTYPE html>
<html lang="en">
<meta http-equiv="content-type" content="text/html;charset=utf-8" />
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>WiFi5-Soft| Vendo</title>
<link rel="icon" href="/theme/img/i.ico">
<link rel="stylesheet" href="/theme/css/font-awesome.min.css">
<link rel="stylesheet" href="/theme/css/materialdesignicons.min.css">
<link rel="stylesheet" href="/theme/css/vendor.bundle.base.css">
<link rel="stylesheet" href="/theme/css/style.css">
<script src="/theme/js/jquery.min.js"></script>
<script src="/theme/js/toast.js"></script>
</head>
<body>
<div class="container-scroller">
<nav class="sidebar sidebar-offcanvas" id="sidebar" style="z-index:999999;">
<div class="sidebar-brand-wrapper d-none d-lg-flex align-items-center justify-content-center fixed-top">
<a class="sidebar-brand brand-logo" href="?page=dashboard"><img src="/theme/img/logo.png" alt="logo" style="object-fit:cover;"/></a>
<a class="sidebar-brand brand-logo-mini" href="?page=dashboard"><img src="/theme/img/logo-min.png" alt="logo" style="object-fit:cover;"/></a>
</div>
<ul class="nav">
<li class="nav-item nav-category"><span class="nav-link">Navigation</span></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=dashboard"><span class="menu-icon"><i class="mdi mdi-speedometer"></i></span><span class="menu-title">Dashboard</span></a></li>
<li id="movie-nav" style="display:none;" class="nav-item menu-items"><a class="nav-link" href="?page=media"><span class="menu-icon"><i class="mdi mdi-movie"></i></span><span class="menu-title">Movies</span></a></li>
<li id="eload-parent" class="nav-item menu-items"><a class="nav-link" href="?page=eload"><span class="menu-icon"><i class="mdi mdi-cash"></i></span><span class="menu-title">E-load</span></a></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=logs"><span class="menu-icon"><i class="mdi mdi-format-align-justify"></i></span><span class="menu-title">Logs</span></a></li>
</ul>
</nav>
<div class="container-fluid page-body-wrapper">
<nav class="navbar p-0 fixed-top d-flex flex-row">
<div class="navbar-brand-wrapper d-flex d-lg-none align-items-center justify-content-center">
<a class="navbar-brand brand-logo-mini" href="?page=dashboard"><img src="/theme/img/logo.png" alt="logo" style="object-fit:cover;"/></a>
</div>
<div class="navbar-menu-wrapper flex-grow d-flex align-items-stretch">
<button class="navbar-toggler navbar-toggler align-self-center" type="button" data-toggle="minimize"><span class="mdi mdi-menu"></span></button>
<ul class="navbar-nav w-100"></ul>
<ul class="navbar-nav navbar-nav-right">
<li class="nav-item dropdown border-left"><a class="nav-link" href="/apk/wifi5-softweb.apk"><i class="mdi mdi-android" style="color:#00d600;"></i></a></li>
<li class="nav-item dropdown border-left" style="height:35px;padding:0 5px;display:flex;align-items:center;"><span id="credit" class="menu-title" style="white-space:nowrap;font-size:18px;">&#8369; 0.00</span></li>
</ul>
<button class="navbar-toggler navbar-toggler-right d-lg-none align-self-center" type="button" data-toggle="offcanvas"><span class="mdi mdi-format-line-spacing"></span></button>
</div>
</nav>
<div class="main-panel">
<div id="conntent" class="content-wrapper"></div>
<footer class="footer">
<div class="d-sm-flex justify-content-center justify-content-sm-between">
<span class="text-muted d-block text-center text-sm-left d-sm-inline-block">WiFi5-Soft <a class="text-primary" href="https://www.facebook.com/groups/196946467417134" target="_blank">Facebook Page</a><br> Developed By <a href="https://www.facebook.com/extrans.wifi5" target="_blank">J-Olive</a><br><a id="version"></a></span>
</div>
</footer>
</div>
</div>
</div>
<div id="spinner" class="spin" style="display:none;"><i class="fa fa-spinner fa-spin fa-3x fa-fw" style="top:calc(50% - 70px);left:calc(50% - 35px);position:fixed;"></i></div>
<script src="/theme/js/vendor.bundle.base.js"></script>
<script src="/theme/js/off-canvas.js"></script>
<script src="/theme/js/misc.js"></script>
<script>
// Real widget markup recovered from global.js's creditbox/clientstatus
// (legacy/wifi5-soft/frontend-decrypted/public/client/defualt-theme/
// global.js) — the fragment contents are theirs, this assembly/wiring is
// ours, since the original dashboard.js that would have done this is
// empty in the decrypted archive (server-injected at runtime, never static).
var clientstatus = $('<div class="card" style="min-height:86px;margin-bottom:10px;"><h4 class="card-title" id="title-status" style="display:flex;border-bottom:1px solid;padding:5px;margin:5px 10px;"></h4><div class="card-body" style="display:flex;padding:16px 20px;justify-content:space-around;"><div style="margin-right:20px;width:65%;display:grid;justify-content:center;padding-left:15px;"><div class="row" style="align-content:flex-end;"><div class="d-flex align-items-center align-self-start"><h3 class="mb-0 text-success" id="client-duration"></h3></div></div><h6 class="text-muted font-weight-normal">Current Duration</h6></div></div></div>');
var creditbox = $('<div class="card" style="min-height:86px;"><div class="card-body" style="display:flex;padding:10px 20px;justify-content:space-around;"><div style="margin-right:20px;width:75%;display:grid;justify-content:center;padding-left:15px;"><div class="row" style="align-content:flex-end;"><div class="d-flex align-items-center align-self-start"><h3 class="mb-0 text-info" id="client-credit"></h3></div></div></div><div id="insert-btn-parent" style="display:grid;align-items:center;"><button id="client-insert-coin" class="btn btn-outline-warning btn-icon-text" style="height:auto;"><i class="mdi mdi-coin btn-icon-prepend mdi-48px"></i><span id="insert1" class="d-inline-block text-left blink" style="margin:auto;font-size:18px;font-weight:bold;">INSERT COIN</span></button></div></div></div>');
$('#conntent').append(clientstatus).append(creditbox);
$('#client-insert-coin').on('click', function () {
  $.post('/api/pay-intent').done(function () { toastada.info('Insert your coin now.'); });
});
function poll() {
  $.getJSON('/api/status').done(function (s) {
    $('#title-status').text(s.active ? 'Online' : 'Offline');
    $('#client-duration').text(s.active ? Math.floor(s.remainingSeconds / 60) + 'm ' + (s.remainingSeconds % 60) + 's' : '00:00');
    $('#client-credit').text(s.active ? 'Connected' : 'Insert coin to continue');
    $('#credit').html('&#8369; ' + (s.active ? s.remainingSeconds : 0));
  });
}
poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function loginForm() {
  return `<div id="admin-login-form" class="card" style="max-width:360px;margin:60px auto;">
<div class="card-body">
<h4 class="card-title">Admin Login</h4>
<p id="login-error" class="text-danger" style="display:none;">Invalid username or password.</p>
<div class="form-group"><label>Username</label><input id="login-username" class="form-control" type="text"></div>
<div class="form-group"><label>Password</label><input id="login-password" class="form-control" type="password"></div>
<button id="login-submit" class="btn btn-outline-warning">Login</button>
</div>
</div>
<script>
$('#login-submit').on('click', function () {
  $.ajax({ url: '/admin/login', method: 'POST', contentType: 'application/json',
    data: JSON.stringify({ username: $('#login-username').val(), password: $('#login-password').val() }) })
    .done(function (r) { if (r.ok) location.reload(); else $('#login-error').show(); });
});
</script>`;
}

// Real session data (mac, credit, remaining time) from session.all() — this
// is real device state, not a mock. Every other menu item (Eload, Vouchers,
// PPPoE, Network, Sales, Logs) still has no backend; that's a future
// sub-project, same as before.
function dashboardContent(sessionsByMac, now = Date.now()) {
  const rows = Object.values(sessionsByMac).map((s) => {
    const remaining = Math.max(0, Math.round((s.expiresAt - now) / 1000));
    return `<tr><td>${escapeHtml(s.mac)}</td><td>${s.creditPesos}</td><td>${remaining}s</td></tr>`;
  }).join('');
  return `<div class="card" style="margin-top:20px;">
<div class="card-body">
<h4 class="card-title">Active Sessions</h4>
<table class="table"><thead><tr><th>MAC</th><th>Credit (&#8369;)</th><th>Remaining</th></tr></thead>
<tbody id="sessions-tbody">${rows || '<tr><td colspan="3">No active sessions</td></tr>'}</tbody></table>
<button id="logout-btn" class="btn btn-outline-danger">Logout</button>
</div>
</div>
<script>
$('#logout-btn').on('click', function () {
  $.ajax({ url: '/admin/logout', method: 'POST' }).done(function () { location.reload(); });
});
</script>`;
}

// Real admin ("nav") shell, verbatim structure. Login is real (lib/admin.js
// + config/admin.json); the dashboard shows real session data. Every other
// menu item (Eload, Vouchers, PPPoE, Network, Sales, Logs) has no backend
// yet — deferred to a future sub-project, same scope line as before.
function adminPage(content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="content-type" content="text/html;charset=utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>Admin| Vendo</title>
<link rel="icon" href="/theme/img/i.ico">
<link rel="stylesheet" href="/theme/css/font-awesome.min.css">
<link rel="stylesheet" href="/theme/css/materialdesignicons.min.css">
<link rel="stylesheet" href="/theme/css/admin-style.css">
<script src="/theme/js/jquery.min.js"></script>
<script src="/theme/js/toast.js"></script>
</head>
<body>
<div class="container-scroller">
<nav class="sidebar sidebar-offcanvas" id="sidebar">
<div class="sidebar-brand-wrapper d-none d-lg-flex align-items-center justify-content-center fixed-top">
<a class="sidebar-brand brand-logo" href="?page=dashboard"><img src="/theme/img/logo.png" alt="logo"/></a>
<a class="sidebar-brand brand-logo-mini" href="?page=dashboard"><img src="/theme/img/logo-min.png" alt="logo"/></a>
</div>
<ul class="nav">
<li class="nav-item profile"><div class="profile-desc"><div class="profile-pic"><div class="profile-name"><h5 class="mb-0 font-weight-normal">Vendo</h5><span>Device</span></div></div></div></li>
<li class="nav-item nav-category"><span class="nav-link">Navigation</span></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=dashboard"><span class="menu-icon"><i class="mdi mdi-speedometer"></i></span><span class="menu-title">Dashboard</span></a></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=eload"><span class="menu-icon"><i class="mdi mdi-cash"></i></span><span class="menu-title">Eload</span></a></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=vouchers"><span class="menu-icon"><i class="mdi mdi-barcode"></i></span><span class="menu-title">Vouchers</span></a></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=credit"><span class="menu-icon"><i class="mdi mdi-credit-card-multiple"></i></span><span class="menu-title">Credit</span></a></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=pppoe"><span class="menu-icon"><i class="mdi mdi-settings"></i></span><span class="menu-title">PPPoE</span></a></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=network"><span class="menu-icon"><i class="mdi mdi-lan"></i></span><span class="menu-title">Network</span></a></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=sales"><span class="menu-icon"><i class="mdi mdi-cash-multiple"></i></span><span class="menu-title">Sales</span></a></li>
<li class="nav-item menu-items"><a class="nav-link" href="?page=logs"><span class="menu-icon"><i class="mdi mdi-format-align-justify"></i></span><span class="menu-title">Logs</span></a></li>
</ul>
</nav>
<div class="container-fluid page-body-wrapper">
<nav class="navbar p-0 fixed-top d-flex flex-row">
<div class="navbar-menu-wrapper flex-grow d-flex align-items-stretch">
<button class="navbar-toggler navbar-toggler align-self-center" type="button" data-toggle="minimize"><span class="mdi mdi-menu"></span></button>
<ul class="navbar-nav w-100"></ul>
<button class="navbar-toggler navbar-toggler-right d-lg-none align-self-center" type="button" data-toggle="offcanvas"><span class="mdi mdi-format-line-spacing"></span></button>
</div>
</nav>
<div class="main-panel">
<div id="conntent" class="content-wrapper">${content}</div>
<footer class="footer"><div class="d-sm-flex justify-content-center justify-content-sm-between"><span class="text-muted">WiFi5-Soft admin</span></div></footer>
</div>
</div>
</div>
<script src="/theme/js/vendor.bundle.base.js"></script>
<script src="/theme/js/off-canvas.js"></script>
<script src="/theme/js/admin-misc.js"></script>
</body>
</html>`;
}

const ADMIN_COOKIE = 'vendo5_admin';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
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

function createServer({ session, arp, ratePesosPerMinute, adminAuth }) {
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

    const isAdminSession = () => adminAuth.verify(parseCookies(req)[ADMIN_COOKIE]);

    if (req.method === 'GET' && (req.url === '/admin' || req.url.startsWith('/admin?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(adminPage(isAdminSession() ? dashboardContent(session.all()) : loginForm()));
      return;
    }

    if (req.method === 'POST' && req.url === '/admin/login') {
      readJsonBody(req).then(({ username, password }) => {
        const token = adminAuth.login(username, password);
        if (token) res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${token}; HttpOnly; Path=/`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !!token }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/admin/logout') {
      adminAuth.logout(parseCookies(req)[ADMIN_COOKIE]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/admin/api/sessions') {
      if (!isAdminSession()) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session.all()));
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

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(clientPage());
  });

  return { server, consumePendingPayer };
}

module.exports = { createServer };
