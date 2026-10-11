const { parseCookies, COOKIE } = require('../wire/server');

const MAX_BODY = 8192;

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { if (body.length < MAX_BODY) body += c; });
    req.on('end', () => resolve(body.slice(0, MAX_BODY)));
    req.on('error', () => resolve(''));
  });
}

// The /admin page routes and the frontend's static files. handle(req, res) returns true when it
// answered the request. Paths are the original's:
//   GET  /admin[?page=id]  login page, or the shell for an enabled page
//   POST /admin            JSON {logout:true} ends the session; otherwise the login form's submit
function createAdminRoutes({ pages, sessions, serveStatic }) {
  const cookieHeader = (id, seconds) => `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${seconds}`;
  const html = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  const redirect = (res, location, extra = {}) => res.writeHead(302, { Location: location, ...extra }).end();

  async function post(req, res) {
    const raw = await readBody(req);
    let json = null;
    try { json = JSON.parse(raw); } catch { /* the login form posts urlencoded */ }
    const session = sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    if (json && json.logout === true) {
      if (session) sessions.destroy(session.id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0` });
      res.end('{}');
      return;
    }
    redirect(res, session && session.allowed ? '/admin?page=dashboard' : '/admin');
  }

  function get(req, res, url) {
    let session = sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    const extra = {};
    if (!session) {
      session = sessions.create();
      extra['Set-Cookie'] = cookieHeader(session.id, sessions.ttlSeconds);
    }
    if (!session.allowed) {
      html(res, 200, pages.renderLogin(), extra);
      return;
    }
    const page = url.searchParams.get('page');
    if (page === 'ticket') {
      html(res, 200, pages.renderTicket(), extra);
      return;
    }
    if (!page || !pages.isEnabled(page)) {
      redirect(res, '/admin?page=dashboard', extra);
      return;
    }
    html(res, 200, pages.renderShell(page), extra);
  }

  return function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/admin') {
      if (req.method === 'GET') { get(req, res, url); return true; }
      if (req.method === 'POST') { post(req, res); return true; }
      return false;
    }
    return serveStatic(req, res);
  };
}

module.exports = { createAdminRoutes };
