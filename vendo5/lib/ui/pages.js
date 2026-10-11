const fs = require('node:fs');
const path = require('node:path');

// Pages that work today. Each later sub-project adds its ids here. 'chat' and 'console' are
// not menu pages: they gate the top-bar chat envelope and the web-terminal icon.
// Every page of the original menu is shown (plus the navbar chat link and the console button). A page whose
// backend is not built yet loads but has no data; the pages are filled in sub-project by sub-project.
const DEFAULT_ENABLED = ['dashboard', 'eload-profile', 'eload-product', 'eload-sales', 'eload-logs', 'payment-profile', 'payment-sales', 'payment-logs', 'media', 'chat', 'devices', 'phone-rental', 'phone-rental-sales', 'vouchers', 'credit', 'pppoe-account', 'pppoe-html', 'pppoe-billing', 'reseller', 'themes', 'settings', 'ntp-client', 'scheduler', 'sales', 'vcsales', 'interfaces', 'dhcp', 'utility', 'nft', 'leases', 'wireless', 'logs', 'console'];

// Profile-menu items that need features this product does not have (remote update from a URL,
// software up/download, data export/import). Hidden until a later sub-project builds them.
const HIDDEN_PROFILE_ITEMS = []; // every item of the 3-dots menu is shown; Export/Import are a local backup, the updates come from a link or a file you give

const PAGE_LINK = /href="\?page=([\w-]+)"/g;
const SUBMENU = /[ \t]*<ul class="nav flex-column sub-menu">[\s\S]*?<\/ul>[ \t]*\r?\n?/g;

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Index just past the </li> that closes the <li> opening at `start` (tag-balanced).
function endOfLi(html, start) {
  const re = /<(\/?)li\b[^>]*>/g;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  throw new Error(`unbalanced <li> starting at ${start}`);
}

// Replace every balanced <li> that opens with `openRe` by decide(block).
function rewriteBlocks(html, openRe, decide) {
  const re = new RegExp(openRe.source, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    const end = endOfLi(html, m.index);
    out += html.slice(last, m.index) + decide(html.slice(m.index, end));
    last = end;
    re.lastIndex = end;
  }
  return out + html.slice(last);
}

const pagesIn = (block) => [...block.matchAll(PAGE_LINK)].map((x) => x[1]);

// Sidebar: drop pages that are not enabled; drop a whole group once none of its pages remain.
function trimMenu(html, enabled) {
  return rewriteBlocks(html, /<li class="nav-item menu-items">/, (block) => {
    const pages = pagesIn(block);
    if (!pages.length) return block;
    if (/data-toggle="collapse"/.test(block)) {
      const kept = block.replace(SUBMENU, (ul) => {
        const p = pagesIn(ul)[0];
        return p && enabled.has(p) ? ul : '';
      });
      return /sub-menu/.test(kept) ? kept : '';
    }
    return enabled.has(pages[0]) ? block : '';
  });
}

// Top bar: the chat envelope links to a page, the terminal icon needs the 'console' feature.
function trimNavbar(html, enabled) {
  return rewriteBlocks(html, /<li class="nav-item dropdown border-left">/, (block) => {
    const p = pagesIn(block)[0];
    const hide = (p && !enabled.has(p)) || (/id="console"/.test(block) && !enabled.has('console'));
    return hide ? '' : block;
  });
}

// Profile dropdown: each item is "<divider><a id=X class=dropdown-item ...>...</a>".
function trimProfile(html, hiddenIds) {
  const re = /[ \t]*<div class="dropdown-divider"><\/div>\s*<a id="([\w-]+)" class="dropdown-item preview-item">[\s\S]*?<\/a>[ \t]*\r?\n?/g;
  return html.replace(re, (m, id) => (hiddenIds.includes(id) ? '' : m));
}

// The login page submits its <form> after the socket login. With name attributes the browser
// would post the typed password in plaintext; the script reads the fields by id, so drop them.
function stripLoginNames(html) {
  return html.replace(/ name="admin-(?:username|password)"/g, '');
}


// The shell reloads the page whenever its socket disconnects. Firefox closes the socket as soon as you
// navigate away, so that reload can overtake the click (Dashboard -> Logs lands back on Dashboard). This
// tiny script, run right after socket.io.js, makes the disconnect handler stand down once the page is
// already leaving. It touches nothing else; the vendor files are served exactly as shipped.
const LEAVING_SHIM = `<script>(function () {
  var leaving = false;
  addEventListener('beforeunload', function () { leaving = true; });
  var on = io.Socket.prototype.on;
  io.Socket.prototype.on = function (ev, fn) {
    if (ev === 'disconnect' && typeof fn === 'function') {
      var orig = fn;
      fn = function () { if (!leaving) return orig.apply(this, arguments); };
    }
    return on.call(this, ev, fn);
  };
})();</script>`;
const SHIM_AFTER = '<script type="text/javascript" src="/socket.io.js?version={2}"></script>';

function createPages({ root, version, hostname, enabled = DEFAULT_ENABLED, hiddenProfileItems = HIDDEN_PROFILE_ITEMS, headScript = '' }) {
  const on = new Set(enabled);
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const raw = read('nav/index.html');
  if (!raw.includes(SHIM_AFTER)) throw new Error('nav/index.html: the socket.io.js script tag the leaving-shim follows was not found');
  const shell = trimProfile(trimNavbar(trimMenu(raw.replace(SHIM_AFTER, SHIM_AFTER + LEAVING_SHIM + headScript), on), on), hiddenProfileItems);
  const login = stripLoginNames(read('main/index.html'));
  const ticket = read('nav/ticket.html');
  const host = escapeHtml(String(hostname).toUpperCase());
  const fill = (html) => html.replace(/\{1\}/g, host).replace(/\{2\}/g, escapeHtml(version));
  return {
    isEnabled: (id) => on.has(id),
    renderLogin: () => fill(login),
    // "@script.js" in the shell is a placeholder for the per-page script, as in the original.
    // The print view of a saved ticket batch: a standalone page (no menu), opened from the Vouchers page.
    renderTicket: () => fill(ticket.replace('@script.js', 'script/ticket.js')),
    renderShell: (page) => fill(shell.replace('@script.js', `script/${page}.js`)),
  };
}

module.exports = { LEAVING_SHIM, SHIM_AFTER, escapeHtml, createPages, trimMenu, trimNavbar, trimProfile, stripLoginNames, endOfLi, DEFAULT_ENABLED, HIDDEN_PROFILE_ITEMS };
