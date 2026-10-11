const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_EXT = new Set(['.html', '.htm', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.mp3', '.mp4', '.woff', '.woff2', '.ttf', '.txt']);
const MAX_FILE = 20 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const SEG = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;

// A small file area (the admin's "Files" manager): a root directory, URL-style paths below "/files", every operation
// confined to the root. Returns null / false for anything unsafe instead of throwing.
function createFileArea({ root, prefix = '/files' }) {
  const base = path.resolve(root);

  // '/files/a/b.png' -> absolute path under root, or null
  function resolve(urlPath) {
    if (typeof urlPath !== 'string' || !(urlPath === prefix || urlPath.startsWith(prefix + '/'))) return null;
    const segs = urlPath.slice(prefix.length).split('/').filter(Boolean);
    if (segs.length > 8 || !segs.every((s) => SEG.test(s) && s !== '..')) return null;
    const abs = path.join(base, ...segs);
    return abs === base || abs.startsWith(base + path.sep) ? abs : null;
  }

  return {
    resolve,
    list(urlPath) {
      const dir = resolve(urlPath);
      if (!dir) return null;
      try {
        fs.mkdirSync(base, { recursive: true });
        return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => (e.isFile() || e.isDirectory()) && SEG.test(e.name)).slice(0, MAX_ENTRIES).map((e) => {
          const st = fs.statSync(path.join(dir, e.name));
          return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', mtime: st.mtime.toUTCString(), size: e.isFile() ? st.size : undefined };
        });
      } catch {
        return null;
      }
    },
    remove(urlPath) {
      const abs = resolve(urlPath);
      if (!abs || abs === base) return false;
      try { fs.rmSync(abs, { recursive: true }); return true; } catch { return false; }
    },
    rename(oldPath, newPath) {
      const a = resolve(oldPath);
      const b = resolve(newPath);
      if (!a || !b || a === base || b === base || fs.existsSync(b)) return false;
      if (!fs.statSync(a, { throwIfNoEntry: false })) return false;
      if (fs.statSync(a).isFile() && !ALLOWED_EXT.has(path.extname(b).toLowerCase())) return false;
      try { fs.renameSync(a, b); return true; } catch { return false; }
    },
    // Write a readable stream into dir/<name>; at most MAX_FILE bytes, an allowed extension, never over an existing directory.
    save(urlDir, name, stream) {
      const dir = resolve(urlDir);
      return new Promise((done) => {
        if (!dir || !SEG.test(String(name)) || !ALLOWED_EXT.has(path.extname(String(name)).toLowerCase())) { stream.resume(); return done(false); }
        let n = 0;
        let bad = false;
        const dest = path.join(dir, name);
        const tmp = `${dest}.part`;
        try { fs.mkdirSync(dir, { recursive: true }); } catch { stream.resume(); return done(false); }
        if (fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory()) { stream.resume(); return done(false); }
        const out = fs.createWriteStream(tmp);
        stream.on('data', (c) => { n += c.length; if (n > MAX_FILE && !bad) { bad = true; out.destroy(); } });
        stream.on('end', () => {
          if (bad) { fs.rmSync(tmp, { force: true }); return done(false); }
          out.end(() => { try { fs.renameSync(tmp, dest); done(true); } catch { done(false); } });
        });
        stream.on('error', () => { out.destroy(); fs.rmSync(tmp, { force: true }); done(false); });
        out.on('error', () => { bad = true; });
        stream.pipe(out);
      });
    },
    mkdir(urlPath) {
      const abs = resolve(urlPath);
      if (!abs || abs === base) return false;
      try { fs.mkdirSync(abs, { recursive: false }); return true; } catch { return false; }
    },
  };
}

module.exports = { createFileArea, ALLOWED_EXT, MAX_FILE };
