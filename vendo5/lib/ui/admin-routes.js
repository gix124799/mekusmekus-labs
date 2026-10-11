const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCookies, COOKIE } = require('../wire/server');
const { bodyToFile, extractFilePart } = require('../system/upload');
const { exportConfig, importConfig } = require('../system/sysconfig');
const { applyUpdate } = require('../system/appupdate');

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
//   GET  /admin?export=sysconfig         download a backup of the machine's data (logged in)
//   POST /admin?import=sysconfig|wifi-soft  upload a backup / a software update archive (logged in); answers DONE
// system: { stateDir, version, restart(), mainlog, appDir, runCommand, updateEnabled, tmpDir } (optional: without it
// these three are not served).
function createAdminRoutes({ pages, sessions, serveStatic, system }) {
  const cookieHeader = (id, seconds) => `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${seconds}`;
  const html = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  const redirect = (res, location, extra = {}) => res.writeHead(302, { Location: location, ...extra }).end();

  const text = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };

  async function upload(req, res, kind) {
    const tmp = system.tmpDir || os.tmpdir();
    const raw = path.join(tmp, `vendo5-upload-${process.pid}-${Date.now()}`);
    const part = `${raw}.part`;
    try {
      const limit = kind === 'sysconfig' ? 30 * 1024 * 1024 : 200 * 1024 * 1024;
      if (!(await bodyToFile(req, raw, limit))) return text(res, 413, 'Error');
      if (!(await extractFilePart(raw, req.headers['content-type'], part))) return text(res, 400, 'Error');
      if (kind === 'sysconfig') {
        const r = importConfig(system.stateDir, fs.readFileSync(part));
        if (!r.ok) return text(res, 200, 'Error');
        system.mainlog.write('system', `Admin restored a backup (${r.count} files)`);
      } else {
        if (!system.updateEnabled) return text(res, 200, 'Error');
        const r = applyUpdate({ archive: part, appDir: system.appDir, runCommand: system.runCommand });
        if (!r.ok) return text(res, 200, 'Error');
        system.mainlog.write('system', `Admin installed the software ${r.version} from an uploaded file`);
      }
      text(res, 200, 'DONE');
      system.restart(); // the restored data / new code is picked up by a fresh start
    } finally {
      fs.rmSync(raw, { force: true });
      fs.rmSync(part, { force: true });
    }
  }

  async function post(req, res, url) {
    const kind = url.searchParams.get('import');
    if (system && (kind === 'sysconfig' || kind === 'wifi-soft')) {
      const s = sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
      if (!s || !s.allowed) { req.resume(); return text(res, 401, 'Error'); }
      return upload(req, res, kind);
    }
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
    if (system && url.searchParams.get('export') === 'sysconfig') {
      const body = exportConfig(system.stateDir, system.version);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="vendo5-backup.json"', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
      system.mainlog.write('system', 'Admin downloaded a backup');
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
      if (req.method === 'POST') { post(req, res, url); return true; }
      return false;
    }
    return serveStatic(req, res);
  };
}

module.exports = { createAdminRoutes };
