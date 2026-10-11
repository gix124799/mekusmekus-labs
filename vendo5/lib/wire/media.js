const asObj = (v) => (v && typeof v === 'object' ? v : {});

// The Media page: attached disks, the media list on each, and per-file edits. The movie feature is part of the
// offline licence, so there is never an "upgrade your license" answer.
function createMediaHandlers({ media, mainlog }) {
  const log = (t) => mainlog.write('system', t);
  return {
    '@nav-03214569': {
      guard: true,
      fallback: null,
      handler(payload) {
        const p = asObj(payload);
        switch (p.action) {
          case 'GETDISK': return media.disks();
          case 'GETLIST': {
            const mp = asObj(p.info).mountpoint;
            const list = media.list(mp);
            return list ? { list, info: asObj(p.info) } : null;
          }
          case 'SETFREE': media.setFree(p.free); log(`Admin set the media to ${p.free ? 'free' : 'paid'}`); return null;
          case 'REMOVE': { const ok = media.remove(p.path); if (ok) log(`Admin removed the media file ${String(p.path).slice(-60)}`); return ok ? null : 'Error'; }
          case 'SETINFO': {
            // path is a file on a disk, folder is its id in that disk's list
            const mp = media.disks().partition.map((x) => x.mountpoint).find((m) => typeof p.path === 'string' && p.path.startsWith(`${m}/`));
            return mp && media.setInfo(mp, p.folder, p) ? null : 'Error';
          }
          case 'SETPOS': return media.setOrder(p.path, p.info) ? null : 'Error';
          default: return 'Error';
        }
      },
    },
  };
}

module.exports = { createMediaHandlers };
