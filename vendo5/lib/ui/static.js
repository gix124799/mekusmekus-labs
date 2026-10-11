const fs = require('node:fs');
const path = require('node:path');

// The asset set the original nginx served, minus .apk (phone rental is hidden). No .html:
// pages are only ever served through routes, never as raw files.
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
};

// Returns serveStatic(req, res) -> true when it answered the request (including a 404 for an
// allowed type that does not exist), false when the request is not a static asset at all.
function createStatic({ root }) {
  const base = path.resolve(root);
  return function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname;
    try {
      pathname = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      return false; // malformed percent-encoding is never a file
    }
    if (pathname.includes('\0')) return false;
    const type = TYPES[path.extname(pathname).toLowerCase()];
    if (!type) return false;
    if (pathname.split('/').some((seg) => seg.startsWith('.'))) return false; // dotfiles and ".."
    const file = path.resolve(base, '.' + pathname);
    if (!file.startsWith(base + path.sep)) return false;
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'public, max-age=3600' });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
    return true;
  };
}

module.exports = { createStatic, TYPES };
