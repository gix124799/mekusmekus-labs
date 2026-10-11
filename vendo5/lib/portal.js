const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getRecent, log } = require('./logger');

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
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }).then(function (r) { return r.json(); });
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
<div class="tag">They Invent. We Reinvent.</div>
</div>`, `
document.getElementById('client-insert-coin').onclick = function () {
  post('/api/pay-intent').then(function () { toastada.info('Insert your coin now.'); });
};
function poll() {
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    var m = Math.floor(s.remainingSeconds / 60), sec = s.remainingSeconds % 60;
    document.getElementById('title-status').textContent = s.active ? 'Online' : 'Offline';
    document.getElementById('title-status').className = s.active ? 'on' : '';
    document.getElementById('client-duration').textContent = s.active ? m + 'm ' + sec + 's' : '00:00';
    document.getElementById('client-credit').textContent = s.active ? 'Connected' : 'Insert coin to continue';
  });
}
poll(); setInterval(poll, 2000);`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function loginForm() {
  return `<div id="admin-login-form" class="card">
<h2>Admin Login</h2>
<p id="login-error" class="err" style="display:none;">Invalid username or password.</p>
<label>Username</label><input id="login-username" type="text" autocomplete="username">
<label>Password</label><input id="login-password" type="password" autocomplete="current-password">
<button id="login-submit">LOGIN</button>
</div>`;
}

const LOGIN_JS = `
document.getElementById('login-submit').onclick = function () {
  post('/admin/login', { username: document.getElementById('login-username').value, password: document.getElementById('login-password').value })
    .then(function (r) { if (r.ok) location.reload(); else document.getElementById('login-error').style.display = 'block'; });
};`;

const LOGOUT_JS = `
document.getElementById('logout-btn').onclick = function () { post('/admin/logout').then(function () { location.reload(); }); };`;

// Real session data (mac, credit, remaining time) from session.all().
function dashboardContent(sessionsByMac, now = Date.now()) {
  const list = Object.values(sessionsByMac);
  const total = list.reduce((n, s) => n + s.creditPesos, 0);
  const rows = list.map((s) => {
    const remaining = Math.max(0, Math.round((s.expiresAt - now) / 1000));
    return `<tr data-mac-row="${escapeHtml(s.mac)}"><td>${escapeHtml(s.mac)}</td><td>${s.creditPesos}</td><td>${remaining}s</td>` +
      `<td><button data-revoke-mac="${escapeHtml(s.mac)}" class="ghost">Revoke</button> ` +
      `<input data-credit-input="${escapeHtml(s.mac)}" type="number" min="1" step="1" style="width:4em;"> ` +
      `<button data-credit-mac="${escapeHtml(s.mac)}" class="ghost">Add credit</button></td></tr>`;
  }).join('');
  return `<div class="card">
<h2>Active Sessions: ${list.length} &middot; Credit: &#8369;${total}</h2>
<table><thead><tr><th>MAC</th><th>Credit (&#8369;)</th><th>Remaining</th><th></th></tr></thead>
<tbody id="sessions-tbody">${rows || '<tr><td colspan="4">No active sessions</td></tr>'}</tbody></table>
</div>
<div class="card"><h2>Recent Activity</h2><pre id="logs-panel" style="max-height:300px;overflow:auto;"></pre></div>
<div class="top"><span></span><button id="logout-btn" class="ghost">Logout</button></div>`;
}

const DASHBOARD_JS = `
${LOGOUT_JS}
function renderSessions(s) {
  var tbody = document.getElementById('sessions-tbody');
  var macs = Object.keys(s);
  tbody.innerHTML = macs.length ? macs.map(function (mac) {
    var row = s[mac];
    var remaining = Math.max(0, Math.round((row.expiresAt - Date.now()) / 1000));
    return '<tr><td>' + mac + '</td><td>' + row.creditPesos + '</td><td>' + remaining + 's</td>' +
      '<td><button data-revoke-mac="' + mac + '" class="ghost">Revoke</button> ' +
      '<input data-credit-input="' + mac + '" type="number" min="1" step="1" style="width:4em;"> ' +
      '<button data-credit-mac="' + mac + '" class="ghost">Add credit</button></td></tr>';
  }).join('') : '<tr><td colspan="4">No active sessions</td></tr>';
  wireActionButtons();
}
function renderLogs(lines) {
  document.getElementById('logs-panel').textContent = lines.map(function (l) { return JSON.stringify(l); }).join('\\n');
}
function wireActionButtons() {
  document.querySelectorAll('[data-revoke-mac]').forEach(function (btn) {
    btn.onclick = function () { post('/admin/api/sessions/' + btn.dataset.revokeMac + '/revoke').then(refresh); };
  });
  document.querySelectorAll('[data-credit-mac]').forEach(function (btn) {
    btn.onclick = function () {
      var mac = btn.dataset.creditMac;
      var input = document.querySelector('[data-credit-input="' + mac + '"]');
      post('/admin/api/sessions/' + mac + '/credit', { pesos: Number(input.value) }).then(refresh);
    };
  });
}
function refresh() {
  fetch('/admin/api/sessions').then(function (r) { return r.json(); }).then(renderSessions);
  fetch('/admin/api/logs').then(function (r) { return r.json(); }).then(renderLogs);
}
wireActionButtons();
refresh();
setInterval(refresh, 2000);`;

function adminPage(content, loggedIn) {
  return shell('Admin | MekusMekus Vendo', `<div class="wrap wide">
<img class="banner" src="/theme/banner.jpg" alt="MekusMekus Labs">
${content}
</div>`, loggedIn ? DASHBOARD_JS : LOGIN_JS);
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

function createServer({ session, firewall, arp, ratePesosPerMinute, adminAuth }) {
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
      res.end((isAdminSession() ? adminPage(dashboardContent(session.all()), true) : adminPage(loginForm(), false)));
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

    if (req.method === 'GET' && req.url === '/admin/api/logs') {
      if (!isAdminSession()) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRecent()));
      return;
    }

    const revokeMatch = req.url.match(/^\/admin\/api\/sessions\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revokeMatch) {
      if (!isAdminSession()) { res.writeHead(401).end(); return; }
      const targetMac = decodeURIComponent(revokeMatch[1]);
      if (!(targetMac in session.all())) { res.writeHead(404).end(); return; }
      try {
        firewall.revoke(targetMac);
      } catch (e) {
        log('error', 'admin revoke failed', { action: 'revoke', mac: targetMac, admin: true, error: e.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      session.revoke(targetMac);
      session.save();
      log('info', 'admin revoke', { action: 'revoke', mac: targetMac, admin: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const creditMatch = req.url.match(/^\/admin\/api\/sessions\/([^/]+)\/credit$/);
    if (req.method === 'POST' && creditMatch) {
      if (!isAdminSession()) { res.writeHead(401).end(); return; }
      const targetMac = decodeURIComponent(creditMatch[1]);
      if (!(targetMac in session.all())) { res.writeHead(404).end(); return; }
      readJsonBody(req).then(({ pesos }) => {
        if (typeof pesos !== 'number' || !Number.isFinite(pesos) || pesos <= 0) {
          res.writeHead(400).end();
          return;
        }
        session.addCredit(targetMac, pesos, ratePesosPerMinute);
        try {
          firewall.allow(targetMac);
        } catch (e) {
          log('error', 'admin credit: firewall allow failed', { action: 'credit', mac: targetMac, pesos, admin: true, error: e.message });
        }
        session.save();
        log('info', 'admin credit', { action: 'credit', mac: targetMac, pesos, admin: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
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
