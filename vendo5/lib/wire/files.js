const asObj = (v) => (v && typeof v === 'object' ? v : {});

// The PPPoE html page's file manager: rename/remove over a plain event, upload over a socket.io-stream.
// A reply of {code} is the page's way to say it failed.
function createFileHandlers({ area, mainlog }) {
  const log = (t) => mainlog.write('system', t);
  return {
    '@nav-0992837': {
      guard: true,
      fallback: { code: 1 },
      handler(payload) {
        const p = asObj(payload);
        if (p.remove) {
          const ok = area.remove(String(p.path));
          if (ok) log(`Admin removed the file ${String(p.path).slice(0, 80)}`);
          return ok ? {} : { code: 1 };
        }
        if (p.rename) {
          const ok = area.rename(String(p.oldname), String(p.newname));
          if (ok) log(`Admin renamed ${String(p.oldname).slice(0, 60)} to ${String(p.newname).slice(0, 60)}`);
          return ok ? {} : { code: 1 };
        }
        return { code: 1 };
      },
    },
    // stream: the wire server hands (stream, data) to this handler instead of one payload.
    '@nav-099283799': {
      guard: true,
      stream: true,
      fallback: { code: 1 },
      async handler({ stream, data }) {
        const d = asObj(data);
        // path is the full target, "/files/dir/name.ext"
        const full = String(d.path);
        const cut = full.lastIndexOf('/');
        const name = full.slice(cut + 1);
        const ok = cut > 0 && await area.save(full.slice(0, cut), name, stream);
        if (ok) log(`Admin uploaded ${name.slice(0, 60)}`);
        return ok ? {} : { code: 1 };
      },
    },
  };
}

module.exports = { createFileHandlers };
