const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { download, applyUpdate } = require('../system/appupdate');

// "System Update" in the profile menu: download an update archive from a link the admin gives, install it, restart.
// Progress goes back on @SYSTEM-909947 as lines of text, ending with "Done" (the page appends each line).
function createSystemHandlers({ appDir, runCommand, mainlog, restart, enabled, tmpDir = os.tmpdir(), fetch = download, apply = applyUpdate }) {
  let busy = false;
  return {
    '@SYSTEM-30025': {
      guard: true,
      fallback: {},
      async handler(payload, ctx) {
        const say = (t) => ctx.socket.emit('@SYSTEM-909947', t);
        const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
        if (!enabled) { say('Software update is only available on the device itself.'); say('Done'); return {}; }
        if (busy) { say('An update is already running.'); say('Done'); return {}; }
        busy = true;
        const file = path.join(tmpDir, `vendo5-update-${process.pid}.tar.gz`);
        try {
          say(`Downloading ${url.slice(0, 120)}`);
          const d = await fetch(url, file, { onProgress: (pc) => say(`${pc}%`) });
          if (!d.ok) { say(`Error: ${d.error}`); return {}; }
          say('Checking and installing');
          const r = apply({ archive: file, appDir, runCommand });
          if (!r.ok) { say(`Error: ${r.error}`); return {}; }
          mainlog.write('system', `Admin installed the update ${r.version} from ${url.slice(0, 120)}`);
          say(`Installed version ${r.version}. Restarting.`);
          restart();
        } finally {
          fs.rmSync(file, { force: true });
          busy = false;
          say('Done');
        }
        return {};
      },
    },
  };
}

module.exports = { createSystemHandlers };
