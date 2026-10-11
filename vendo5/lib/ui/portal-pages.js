const fs = require('node:fs');
const path = require('node:path');
const { LEAVING_SHIM, escapeHtml } = require('./pages');

const SOCKET_TAG = '<script type="text/javascript" src="/socket.io.js"></script>';

const PAGES = ['dashboard', 'eload', 'logs', 'media'];
const THEMES = ['defualt-theme', 'newTheme'];

// Element switches the original page reads from `hideoptions` (true hides that part of the portal).
function defaultHide() {
  const h = {};
  for (const k of ['redirect', 'vendo', 'hideVendoSelect', 'imgmp3', 'monitor', 'buttonBox', 'clientinfo', 'creditcodebtn', 'genvoucherbtn', 'buyloadbtn', 'moviesbtn', 'Finserttut', 'redeembtn', 'extendvvoucherbtn', 'cashin', 'buydurationonline', 'eload', 'inserttut', 'rates', 'validity', 'estimatedxp', 'pauselimit', 'trialbtn', 'speed', 'extendvoucher', 'insertpopup', 'cnnctextndamnt', 'insertclosebtn', 'inserteload', 'insertgenvoucher', 'chat']) h[k] = false;
  // these need the vendor's online services, so the portal does not offer them
  Object.assign(h, { eload: true, cashin: true, buydurationonline: true, inserteload: true, buyloadbtn: true });
  return h;
}

// The customer portal: the original theme's index.html with its placeholders filled the way the original server
// did -- {1} device name, {2} extra head markup, {3} the page script, {4} the globals the scripts read (the event
// name table `wisft` as base64 JSON, `hideoptions`, `redirecturl`).
function createPortalPages({ root, version, hostname, keys, theme = () => 'defualt-theme', hide = () => ({}), redirect = () => '', headScript = '' }) {
  const host = escapeHtml(String(hostname).toUpperCase());
  const cache = new Map();
  const template = (name) => {
    if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(root, 'client', name, 'index.html'), 'utf8'));
    return cache.get(name);
  };
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

  return {
    pages: PAGES,
    themeDir: () => (THEMES.includes(theme()) ? theme() : THEMES[0]),
    render(page) {
      const name = THEMES.includes(theme()) ? theme() : THEMES[0];
      let html = template(name);
      if (name !== 'defualt-theme') return html; // the React theme is a single page of its own
      if (!html.includes(SOCKET_TAG)) throw new Error('client index.html: the socket.io.js script tag the leaving-shim follows was not found');
      html = html.replace(SOCKET_TAG, SOCKET_TAG + LEAVING_SHIM + headScript);
      const globals = `var wisft=${json(Buffer.from(JSON.stringify(keys)).toString('base64'))};var hideoptions=${json({ ...defaultHide(), ...hide() })};var redirecturl=${json(String(redirect() || ''))};`;
      return html.replace('{1}', host).replace('{2}', '').replace('{3}', PAGES.includes(page) ? page : 'dashboard').replace('{4}', globals).replace(/\{5\}/g, escapeHtml(version));
    },
  };
}

module.exports = { createPortalPages, defaultHide, PAGES, THEMES };
