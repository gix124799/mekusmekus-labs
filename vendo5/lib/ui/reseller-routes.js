const fs = require('node:fs');
const path = require('node:path');
const { parseCookies } = require('../wire/server');
const { LEAVING_SHIM, SHIM_AFTER, escapeHtml, endOfLi } = require('./pages');

const COOKIE = 'vendo5_rsid';
const PAGES = [['vouchers', 'vouchers'], ['credit', 'credits'], ['sales', 'sales']]; // page -> permission area

// Keep a menu entry only if the reseller may read that area.
function trimSubMenu(html, allowed) {
  let out = html;
  for (const [page] of PAGES) {
    if (allowed.has(page)) continue;
    const re = new RegExp(`<li class="nav-item menu-items">\\s*<a class="nav-link" href="\\?page=${page}">`);
    const m = re.exec(out);
    if (m) out = out.slice(0, m.index) + out.slice(endOfLi(out, m.index));
  }
  return out;
}

// The reseller portal's pages at /reseller: the sub/ frontend, served like the admin's (placeholders filled, the login
// inputs stripped of their names so the password never rides in the form post, the menu cut to what the account may read).
function createResellerRoutes({ root, version, hostname, sessions, resellers }) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const host = escapeHtml(String(hostname).toUpperCase());
  const fill = (html) => html.replace(/\{1\}/g, host).replace(/\{2\}/g, escapeHtml(version));
  const login = fill(read('sub/login.html').replace(/ name="sub-(?:username|password)"/g, ''));
  const rawShell = read('sub/index.html');
  if (!rawShell.includes(SHIM_AFTER)) throw new Error('sub/index.html: the socket.io.js script tag the leaving-shim follows was not found');
  const shell = rawShell.replace(SHIM_AFTER, SHIM_AFTER + LEAVING_SHIM);
  const ticket = read('sub/ticket.html');

  const html = (res, status, body, extra = {}) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(body); };
  const redirect = (res, loc, extra = {}) => res.writeHead(302, { Location: loc, ...extra }).end();
  const cookie = (id, seconds) => `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/reseller; Max-Age=${seconds}`;
  const allowedPages = (acc) => new Set(PAGES.filter(([, area]) => acc.permission[area] && acc.permission[area].read).map(([p]) => p));
  const account = (s) => (s && s.allowed && s.user ? resellers.get(s.user) : null);

  function get(req, res, url) {
    let s = sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    const extra = {};
    if (!s) { s = sessions.create(); extra['Set-Cookie'] = cookie(s.id, sessions.ttlSeconds); }
    const acc = account(s);
    if (!acc) return html(res, 200, login, extra);
    const pages = allowedPages(acc);
    const page = url.searchParams.get('page');
    if (page === 'ticket') {
      if (!(acc.permission.ticket && acc.permission.ticket.read)) return redirect(res, '/reseller', extra);
      return html(res, 200, fill(ticket.replace('@script.js', 'script/ticket.js')), extra);
    }
    if (!page || !pages.has(page)) {
      const first = [...pages][0];
      return first ? redirect(res, `/reseller?page=${first}`, extra) : html(res, 200, fill('<p style="padding:20px;color:#ccc">This account has no pages yet. Ask the administrator for permissions.</p>'), extra);
    }
    return html(res, 200, fill(trimSubMenu(shell, pages).replace('@script.js', `script/${page}.js`)), extra);
  }

  async function post(req, res) {
    let body = '';
    await new Promise((r) => { req.on('data', (c) => { if (body.length < 8192) body += c; }); req.on('end', r); req.on('error', r); });
    let json = null;
    try { json = JSON.parse(body); } catch { /* the login form posts urlencoded */ }
    const s = sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    if (json && json.logout === true) {
      if (s) sessions.destroy(s.id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/reseller; Max-Age=0` });
      return res.end('{}');
    }
    redirect(res, '/reseller'); // the login form's submit: /reseller shows the login page or picks the first page
  }

  return function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/reseller') {
      if (req.method === 'GET') { get(req, res, url); return true; }
      if (req.method === 'POST') { post(req, res); return true; }
      return false;
    }
    return false; // everything else (the sub/ assets included) is the admin routes' static serving
  };
}

module.exports = { createResellerRoutes, trimSubMenu, COOKIE };
