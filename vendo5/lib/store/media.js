const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { jsonFile } = require('./jsonfile');

const EXT = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.mp3', '.m4a', '.ogg']);
const MAX_ITEMS = 5000;
const idOf = (rel) => crypto.createHash('sha1').update(rel).digest('hex').slice(0, 10);

// Media on the attached disk(s). A partition is {name, mountpoint, fssize, label, info:{vendor,model}}; discovery is
// injected (lsblk on the device, a plain folder on a development machine). Each mountpoint keeps its own
// media-list.json: { <id>: { id, file (relative), dir, title, description, category, size, views, watch (seconds), pos } },
// refreshed from the files that are really on the disk (new files appear, deleted ones go).
function createMedia({ partitions, stateFile, now = Date.now }) {
  const state = jsonFile(stateFile, { free: true });

  const mountOk = (mp) => partitions().some((p) => p.mountpoint === mp);
  const listFile = (mp) => path.join(mp, 'media-list.json');

  function scan(mp, dir = '', depth = 0, out = []) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(mp, dir), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (out.length >= MAX_ITEMS || e.name.startsWith('.')) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 2) scan(mp, rel, depth + 1, out);
      else if (e.isFile() && EXT.has(path.extname(e.name).toLowerCase())) out.push(rel);
    }
    return out;
  }

  function load(mp) {
    const meta = jsonFile(listFile(mp), {}).read();
    const list = {};
    const files = scan(mp);
    for (const rel of files) {
      const id = idOf(rel);
      let size = 0;
      try { size = fs.statSync(path.join(mp, rel)).size; } catch { /* vanished while scanning */ }
      const old = meta[id] || {};
      list[id] = { id, file: rel, dir: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), title: old.title || path.basename(rel, path.extname(rel)), description: old.description || '', category: old.category || '', size, views: old.views || 0, watch: old.watch || 0, pos: old.pos ?? Object.keys(list).length };
    }
    return list;
  }
  const save = (mp, list) => jsonFile(listFile(mp), {}).write(list);

  return {
    // path (the device node) and fsuse% are what the disk card prints
    disks: () => ({
      partition: partitions().map((p) => {
        let use = '0%';
        try { const st = fs.statfsSync(p.mountpoint); use = `${Math.round(((st.blocks - st.bfree) / Math.max(1, st.blocks)) * 100)}%`; } catch { /* unmounted meanwhile */ }
        return { path: `/dev/${p.name}`, 'fsuse%': use, ...p };
      }),
      free: state.read().free !== false,
    }),
    setFree(free) { state.write({ ...state.read(), free: !!free }); },
    // The list ordered by pos
    list(mp) {
      if (!mountOk(mp)) return null;
      const list = load(mp);
      return Object.fromEntries(Object.values(list).sort((a, b) => a.pos - b.pos).map((x) => [x.id, x]));
    },
    // Remove a file by its absolute path (it must be a media file inside a known mountpoint).
    remove(file) {
      const mp = partitions().map((p) => p.mountpoint).find((m) => typeof file === 'string' && file.startsWith(m + path.sep));
      if (!mp) return false;
      const abs = path.resolve(file);
      if (!abs.startsWith(path.resolve(mp) + path.sep) || !EXT.has(path.extname(abs).toLowerCase())) return false;
      try { fs.rmSync(abs); } catch { return false; }
      const list = load(mp);
      save(mp, list);
      return true;
    },
    setInfo(mp, id, { title, description, category }) {
      if (!mountOk(mp)) return false;
      const list = load(mp);
      if (!Object.hasOwn(list, id) || typeof title !== 'string' || !title || title.length > 120) return false;
      list[id].title = title;
      list[id].description = String(description || '').slice(0, 500);
      list[id].category = String(category || '').slice(0, 40);
      save(mp, list);
      return true;
    },
    // The page sends the list in its new order
    setOrder(mp, ordered) {
      if (!mountOk(mp) || !ordered || typeof ordered !== 'object') return false;
      const list = load(mp);
      const ids = Object.values(ordered).map((x) => x && x.id).filter((id) => Object.hasOwn(list, id));
      ids.forEach((id, i) => { list[id].pos = i; });
      save(mp, list);
      return true;
    },
    // A client watched something (the portal's player reports it)
    watched(mp, id, seconds) {
      if (!mountOk(mp)) return false;
      const list = load(mp);
      if (!Object.hasOwn(list, id) || !(seconds >= 0 && seconds < 86400)) return false;
      list[id].views += 1;
      list[id].watch += Math.round(seconds);
      save(mp, list);
      return true;
    },
  };
}

// lsblk -J output -> mounted partitions worth showing (not the system root or /boot)
function partitionsFromLsblk(json) {
  let doc;
  try { doc = JSON.parse(json); } catch { return []; }
  const out = [];
  const walk = (n) => {
    if (n.mountpoint && !['/', '/boot', '/rom', '/overlay'].includes(n.mountpoint) && !String(n.mountpoint).startsWith('/tmp') && /^\/mnt\//.test(n.mountpoint)) {
      out.push({ name: n.name, mountpoint: n.mountpoint, fssize: Number(n.size) || 0, label: n.label || '', info: { vendor: (n.vendor || '').trim(), model: (n.model || '').trim() } });
    }
    for (const c of n.children || []) walk(c);
  };
  for (const d of doc.blockdevices || []) walk(d);
  return out;
}

module.exports = { createMedia, partitionsFromLsblk, EXT };
