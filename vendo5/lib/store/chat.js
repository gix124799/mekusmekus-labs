const fs = require('node:fs');
const path = require('node:path');
const { jsonFile } = require('./jsonfile');
const { MAC, noColons } = require('./clients');

const MAX_MESSAGES = 300;
const MAX_TEXT = 1000;
const TYPES = ['text', 'emoji'];

// One conversation per device: <dir>/<mac without colons>.json = { mac, adminseen, clientseen, messages: { <ms>: { type,
// message, sender: 'admin'|'user' } } } and <dir>/auto.json for the auto-reply. Messages are plain text: the admin page
// builds HTML around them itself, so anything with markup is stored escaped.
function createChat({ dir, now = Date.now }) {
  const file = (mac) => path.join(dir, `${noColons(mac)}.json`);
  const conv = (mac) => jsonFile(file(mac), () => ({ mac, adminseen: true, clientseen: true, messages: {} }));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const auto = jsonFile(path.join(dir, 'auto.json'), { interval: 30, message: '', enable: false });

  function clean(smg) {
    if (!smg || typeof smg !== 'object' || !TYPES.includes(smg.type) || typeof smg.message !== 'string') return null;
    const text = smg.message.slice(0, smg.type === 'emoji' ? 2000 : MAX_TEXT);
    // an emoji is the page's own svg; only a plain svg path is accepted there
    if (smg.type === 'emoji') return /^<svg [^<>]*>(<path [^<>]*><\/path>)+<\/svg>$/.test(text) ? { type: 'emoji', message: text } : null;
    return text.trim() ? { type: 'text', message: esc(text) } : null;
  }

  function append(mac, sender, smg, flags) {
    const m = clean(smg);
    if (!m || !MAC.test(String(mac))) return null;
    const c = conv(String(mac).toLowerCase());
    const data = c.read();
    let ts = now();
    while (Object.hasOwn(data.messages, ts)) ts++;
    data.messages[ts] = { ...m, sender };
    const keys = Object.keys(data.messages).sort((a, b) => a - b);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_MESSAGES))) delete data.messages[k];
    Object.assign(data, flags(data));
    data.mac = String(mac).toLowerCase();
    c.write(data);
    return { ts, msg: data.messages[ts] };
  }

  return {
    now,
    sendAdmin: (mac, smg) => append(mac, 'admin', smg, () => ({ clientseen: false })),
    sendClient: (mac, smg) => append(mac, 'user', smg, () => ({ adminseen: false })),
    history: (mac) => (MAC.test(String(mac)) ? conv(String(mac).toLowerCase()).read().messages : {}),
    markAdminSeen(mac) {
      if (!MAC.test(String(mac))) return false;
      const c = conv(String(mac).toLowerCase());
      const d = c.read();
      d.adminseen = true;
      c.write(d);
      return true;
    },
    markClientSeen(mac) {
      if (!MAC.test(String(mac))) return false;
      const c = conv(String(mac).toLowerCase());
      const d = c.read();
      d.clientseen = true;
      c.write(d);
      return true;
    },
    clientHasUnread: (mac) => MAC.test(String(mac)) && conv(String(mac).toLowerCase()).read().clientseen === false,
    // every conversation: { <mac>: { filesize: {mtimeMs, size}, adminseen } }
    list() {
      const out = {};
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return out; }
      for (const f of names) {
        if (!/^[0-9a-f]{12}\.json$/.test(f)) continue;
        try {
          const st = fs.statSync(path.join(dir, f));
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (d && typeof d.mac === 'string' && MAC.test(d.mac)) out[d.mac] = { filesize: { mtimeMs: st.mtimeMs, size: st.size }, adminseen: d.adminseen !== false };
        } catch { /* a half-written file: skipped */ }
      }
      return out;
    },
    unread() {
      const out = {};
      for (const [mac, v] of Object.entries(this.list())) if (v.adminseen === false) out[mac] = true;
      return out;
    },
    remove(mac) {
      if (!MAC.test(String(mac))) return false;
      fs.rmSync(file(String(mac).toLowerCase()), { force: true });
      return true;
    },
    removeAll() {
      let n = 0;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return 0; }
      for (const f of names) if (/^[0-9a-f]{12}\.json$/.test(f)) { fs.rmSync(path.join(dir, f), { force: true }); n++; }
      return n;
    },
    getAuto: () => auto.read(),
    setAuto({ interval, message, enable }) {
      const i = Number(interval);
      if (!(Number.isInteger(i) && i >= 1 && i <= 1440) || typeof message !== 'string' || message.length > MAX_TEXT) return false;
      auto.write({ interval: i, message: esc(message), enable: enable === true });
      return true;
    },
  };
}

module.exports = { createChat };
