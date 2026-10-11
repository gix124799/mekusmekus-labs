# Original UI Foundation (Admin Shell & Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the original WiFi5-Soft admin frontend from vendo5 against a compatible, fully offline backend: login, admin shell, dashboard, logs and notifications.

**Architecture:** The original, unmodified frontend (kept under `legacy/`) is served by vendo5's own `node:http` server; the only edits are made at serve time (placeholders, menu trimming, one small leaving-shim). A socket.io 4.7.5 server mounted at `/admin` speaks the original's opaque `@main-*` / `@nav-*` event contract through plain `(payload, ctx)` handler functions in an event table. Nothing calls out: no licence server, no cloud, no vendor push channel.

**Tech Stack:** Node 22, `node:http`, `node:test`; one runtime dependency (`socket.io` 4.7.5, exact) and one dev dependency (`socket.io-client` 4.7.5, exact).

**Spec:** `docs/superpowers/specs/2026-10-11-original-ui-foundation-design.md` (as amended by "Deviations from the spec" at the end of this plan; the spec file itself was amended in the same commit).

**Provenance of the code below.** Every file in this plan was written and run in a scratch tree before the plan was written: the full suite of 190 tests (the repository's existing ones plus the new ones) passes, and a real headless Firefox drove the original login page, the dashboard, a session removal, the logs page, the notification bell and logout against a real `main.js` (29/29 live checks, no JavaScript error, no off-origin request). The code is therefore not a sketch; if a step's expected output differs from what you see, stop and investigate rather than adapt.

## Global Constraints

- One new runtime dependency only: `socket.io` pinned to the exact version `4.7.5` (the version the original `socket.io.js` ships); dev dependency `socket.io-client` exact `4.7.5`. No Express, no other package.
- Routing stays hand-rolled `node:http`, as in `lib/portal.js`; commands are run through an injectable `runCommand(argv)` (never a shell string), as in `lib/firewall.js`.
- The socket.io server is mounted at `path: '/admin'` with transports `websocket` and `polling`.
- Vendor frontend files stay byte-identical in git; every adaptation happens at serve time. Static serving allows only `.js .css .png .jpg .ico .map .woff .woff2 .ttf .svg .mp3` and **never `.html`**.
- Admin session cookie: `vendo5_sid`, 24 random bytes hex, `HttpOnly; SameSite=Strict; Path=/admin; Max-Age=3600`. No hardcoded secret.
- Login is the original challenge/response: 32-hex token, `a = token.substring(0, (token.length-1)/2)`, `b = token.substring((token.length-1)/2, token.length)`, `md5(a + lowercased username without spaces)`, `md5(b + password without spaces)`, 3000 ms challenge window, one attempt per token.
- The admin account is stored in plaintext in `account.json`, mode 0600, written atomically (temp file + rename). Factory default `admin` / `admin`, with a logged warning.
- Main log files: `<category>-<DD>-<MM>-<YYYY>.txt`, lines `hh:mm:ss am|pm: text`, at most 30 files per category.
- The offline licence object is `{serial, expiration: 8640000000000000, hotspot: 1000000, pppoe: 1000000, custom_theme: true, movie: true, checked: true}`; no code path reads a licence from the network.
- Cloud-only pages (E-load, Online Payment, Phone Rental) are hidden, not stubbed; only `dashboard` and `logs` are enabled.
- Code style of this repo: zero-dependency CommonJS, `node:test`, injectable collaborators, one-line comments that explain why. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- The git root is `~/projects/mekusmekus-labs`; the project is its `vendo5/` subdirectory. Run every command from `vendo5/`.

## Review Focus

The spec says what must work; these are the inputs it implies but no happy-path test would reach. Each has a pinning test in the task named.

1. **An admin password with a space, a non-ASCII character, or upper-case username** must still log in: the browser's md5 takes only the low 8 bits of each character, and strips spaces. A UTF-8 server hash would lock such an admin out. (Task 5: `test/wire-main.test.js`; Task 6: `test/login-flow.test.js`.)
2. **A device with an unwritable state directory or missing UI files** must still sell time: `/admin` is then simply not served and an error is logged. (Task 11: `test/admin-e2e.test.js`.)
3. **Log text or file names crafted by a client**: a newline in logged text must not forge a second line, and `../` or an odd name must neither read nor delete anything outside the log directory. (Task 7: `test/mainlog.test.js`.)
4. **A paid client the ARP table does not know, and junk durations** (`0`, negative, `NaN`, a string) sent to the extend action: the client must still list, and nothing must be extended. (Tasks 9 and 10: `test/session-extend.test.js`, `test/wire-nav.test.js`.)
5. **A forged, missing or expired session cookie** must get no admin data from the socket, and a wrong password must not open the admin events. (Task 6: `test/wire-server.test.js`; Task 11: `test/admin-e2e.test.js`.)

Known and accepted, not covered: the original dashboard sends its first poll before its system-info reply is back and swallows one TypeError (the live test filters exactly that message); real-hardware `ubus` output is unverified (same open item as sub-project #3).

## File Structure

| File | Responsibility |
|---|---|
| `lib/ui/static.js` | serve the frontend's static assets (allowlisted types, no traversal) |
| `lib/ui/pages.js` | page registry + serve-time rendering: placeholders, menu/navbar/profile trimming, leaving-shim, login form name stripping |
| `lib/ui/admin-routes.js` | `GET/POST /admin` and the static fallthrough; returns `true` when it answered |
| `lib/wire/session.js` | in-memory admin sessions keyed by cookie id (allowed, expiry, challenge), capped |
| `lib/wire/server.js` | attaches socket.io at `/admin`, binds sockets to sessions, per-event guard, fallback on handler error |
| `lib/wire/main.js` | login-page handlers: token, verify, version, change password |
| `lib/wire/nav.js` | shell/dashboard/logs/notification handlers |
| `lib/wire/passthrough.js` | the `@nav-23441` read-only command allowlist |
| `lib/system/stats.js` | cpu, ram, temperature, storage, interface counters, `/proc` system info |
| `lib/system/mainlog.js` | dated log files with retention |
| `lib/store/account.js` | plaintext 0600 account file |
| `lib/store/notifications.js` | bell notices in one JSON file |
| `lib/licence.js` | the offline licence object and local device id |
| `lib/session.js`, `lib/arp.js` | small additions: `extend`, `startedAt`, `neighbors` |
| `lib/portal.js`, `main.js`, `lib/config.js` | old admin removed; admin wired in; failures non-fatal |
| `scripts/image-commands.js`, `scripts/build-image.sh` | put the frontend and `socket.io` into the test image |
| `scripts/live-test.py` | live Firefox test of the whole admin |

---

### Task 1: Branch, dependencies, test helper

**Files:**
- Modify: `package.json`, `.gitignore`
- Create: `test/helpers/ui-root.js`

**Interfaces:**
- Produces: `require('./helpers/ui-root')` returns the absolute path of the original frontend tree (`legacy/wifi5-soft/frontend-decrypted/public`); used by every UI test.

- [ ] **Step 1: Create the working branch**

```bash
git checkout spec/original-ui-foundation
git checkout -b feature/original-ui-foundation
```

- [ ] **Step 2: Install the two pinned packages (needs network, once, on the dev machine)**

```bash
npm install --save-exact socket.io@4.7.5
npm install --save-dev --save-exact socket.io-client@4.7.5
node -e "console.log(require('socket.io/package.json').version, require('socket.io-client/package.json').version)"
```

Expected: prints `4.7.5 4.7.5`. `package.json` now has `"dependencies": {"socket.io": "4.7.5"}` and `"devDependencies": {"socket.io-client": "4.7.5"}` (no `^`), and `package-lock.json` exists.

- [ ] **Step 3: Ignore `node_modules`**

Append one line to `.gitignore` so it reads:

```
build/
node_modules/
```

Run: `git status --short`
Expected: `package.json`, `package-lock.json`, `.gitignore` listed; no `node_modules`.

- [ ] **Step 4: Create the test helper**

Create `test/helpers/ui-root.js`:

```js
// The original admin frontend, as kept under legacy/. Tests run against the real files, not copies.
module.exports = require('node:path').join(__dirname, '..', '..', 'legacy', 'wifi5-soft', 'frontend-decrypted', 'public');
```

- [ ] **Step 5: Confirm the suite still runs**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# fail 0` (the existing tests; no new ones yet).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore test/helpers/ui-root.js
git commit -m "chore: pin socket.io 4.7.5 and add the UI test helper

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 2: Static file server

**Files:**
- Create: `lib/ui/static.js`
- Create: `test/static.test.js`

**Interfaces:**
- Consumes: `test/helpers/ui-root.js`.
- Produces: `createStatic({root})` returns `serveStatic(req, res)`: `true` when it answered (including a 404 for an allowed type that does not exist), `false` when the request is not a static asset (wrong method, disallowed type, dotfile, traversal, malformed encoding), so the caller can fall through to the portal.

- [ ] **Step 1: Write the failing tests**

Create `test/static.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createStatic } = require('../lib/ui/static');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5static-'));
  fs.mkdirSync(path.join(root, 'nav'));
  fs.writeFileSync(path.join(root, 'nav', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'nav', 'index.html'), '<html>raw shell</html>');
  fs.writeFileSync(path.join(root, '.secret.js'), 'secret');
  fs.writeFileSync(path.join(path.dirname(root), 'outside-' + path.basename(root) + '.js'), 'outside');
  return root;
}
function serve(root) {
  const serveStatic = createStatic({ root });
  const server = http.createServer((req, res) => {
    if (!serveStatic(req, res)) res.writeHead(200, { 'Content-Type': 'text/plain' }).end('FALLTHROUGH');
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}
const get = (port, p, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ port, path: p, method }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

test('serves an allowed asset with its content type and a cache header', async () => {
  const { server, port } = await serve(fixture());
  try {
    const r = await get(port, '/nav/app.js?version=1');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'console.log(1)');
    assert.match(r.headers['content-type'], /^text\/javascript/);
    assert.match(r.headers['cache-control'], /max-age/);
  } finally { server.close(); }
});

test('an allowed type that does not exist is a 404, not a fall-through', async () => {
  const { server, port } = await serve(fixture());
  try {
    assert.equal((await get(port, '/nav/missing.css')).status, 404);
  } finally { server.close(); }
});

test('html is never served as a raw file (falls through to the routes)', async () => {
  const { server, port } = await serve(fixture());
  try {
    const r = await get(port, '/nav/index.html');
    assert.equal(r.body, 'FALLTHROUGH');
  } finally { server.close(); }
});

for (const bad of ['/../outside-x.js', '/nav/../../etc/passwd.js', '/%2e%2e/%2e%2e/etc/passwd.js', '/.secret.js', '/nav/%00.js', '/%E0.js', '/nav//..//..//x.js']) {
  test(`hostile path ${bad} never returns file content`, async () => {
    const root = fixture();
    const { server, port } = await serve(root);
    try {
      const r = await get(port, bad);
      assert.notEqual(r.body, 'secret');
      assert.notEqual(r.body, 'outside');
      assert.ok(r.status === 404 || r.body === 'FALLTHROUGH', `${r.status} ${r.body}`);
    } finally { server.close(); }
  });
}

test('HEAD returns headers and no body; other methods fall through', async () => {
  const { server, port } = await serve(fixture());
  try {
    const h = await get(port, '/nav/app.js', 'HEAD');
    assert.equal(h.status, 200);
    assert.equal(h.body, '');
    assert.equal((await get(port, '/nav/app.js', 'POST')).body, 'FALLTHROUGH');
  } finally { server.close(); }
});

test('a directory path with an allowed extension is a 404', async () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'dir.js'));
  const { server, port } = await serve(root);
  try {
    assert.equal((await get(port, '/dir.js')).status, 404);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/static.test.js`
Expected: FAIL, `Cannot find module '../lib/ui/static'`.

- [ ] **Step 3: Write the implementation**

Create `lib/ui/static.js`:

```js
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
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test test/static.test.js`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/ui/static.js test/static.test.js
git commit -m "feat: static file server for the admin frontend

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 3: Page renderer and menu trimming

**Files:**
- Create: `lib/ui/pages.js`
- Create: `test/pages.test.js`

**Interfaces:**
- Consumes: `test/helpers/ui-root.js`.
- Produces: `createPages({root, version, hostname, enabled, hiddenProfileItems})` returns `{isEnabled(id), renderLogin(), renderShell(page)}`; also exports `trimMenu, trimNavbar, trimProfile, stripLoginNames, endOfLi, DEFAULT_ENABLED (["dashboard","logs"]), HIDDEN_PROFILE_ITEMS`. `createPages` throws if `nav/index.html` lacks the expected `socket.io.js` tag.

Why each rewrite exists (all verified against the real `nav/index.html` and `main/index.html`): `{1}` is the upper-cased hostname and `{2}` a cache-busting version; `@script.js` becomes `script/<page>.js`; the menu, the navbar chat link and `#console`, and four profile items that need cloud or later pages are removed so nothing unbuilt is reachable; the login inputs lose their `name` attributes, because the page would otherwise submit the **plaintext password** in the form post to `/admin` after logging in over the socket; the leaving-shim fixes a Firefox-only race in the original shell (see its comment).

- [ ] **Step 1: Write the failing tests**

Create `test/pages.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createPages, trimMenu, trimNavbar, trimProfile, stripLoginNames, endOfLi } = require('../lib/ui/pages');

const ROOT = require('./helpers/ui-root');
const pages = () => createPages({ root: ROOT, version: '1.2.3', hostname: 'vendo-one' });
const count = (s, re) => (s.match(re) || []).length;
const links = (html) => [...html.matchAll(/href="\?page=([\w-]+)"/g)].map((m) => m[1]);

test('shell: placeholders are filled and the page script is selected', () => {
  const html = pages().renderShell('dashboard');
  assert.ok(html.includes('/nav/script/dashboard.js?version=1.2.3'));
  assert.ok(html.includes('Admin| VENDO-ONE'));
  for (const left of ['{1}', '{2}', '@script.js']) assert.ok(!html.includes(left), `${left} left in the page`);
  assert.ok(pages().renderShell('logs').includes('/nav/script/logs.js?version=1.2.3'));
});

test('shell: the menu keeps only the enabled pages and stays well-formed', () => {
  const html = pages().renderShell('dashboard');
  const menu = [...html.matchAll(/class="menu-title">([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(menu, ['Dashboard', 'Logs']);
  assert.deepEqual([...new Set(links(html))].sort(), ['dashboard', 'logs']);
  assert.equal(count(html, /<li\b/g), count(html, /<\/li>/g));
  assert.equal(count(html, /<ul\b/g), count(html, /<\/ul>/g));
  assert.equal(count(html, /<div\b/g), count(html, /<\/div>/g));
});

test('shell: cloud pages (e-load, payment, phone rental) are not reachable from the menu', () => {
  const html = pages().renderShell('dashboard');
  for (const id of ['eload-profile', 'eload-product', 'eload-sales', 'eload-logs', 'payment-profile', 'payment-sales', 'payment-logs', 'phone-rental', 'phone-rental-sales']) {
    assert.ok(!html.includes(`page=${id}`), id);
  }
});

test('shell: the top bar drops the chat envelope and the terminal icon', () => {
  const html = pages().renderShell('dashboard');
  assert.ok(!html.includes('id="message-notification"'));
  assert.ok(!html.includes('id="console"'));
  assert.ok(html.includes('id="notificationDropdown"'), 'notifications stay');
});

test('shell: the profile menu hides update/software/export/import and keeps the rest', () => {
  const html = pages().renderShell('dashboard');
  for (const id of ['system-update', 'software-updown', 'export-data', 'import-data']) assert.ok(!html.includes(`id="${id}"`), id);
  for (const id of ['clear-all-data', 'license', 'change-pass', 'system-reboot', 'logout']) assert.ok(html.includes(`id="${id}"`), id);
});

test('enabling more pages and features brings their entries back', () => {
  const html = createPages({ root: ROOT, version: '1', hostname: 'h', enabled: ['dashboard', 'logs', 'vouchers', 'chat', 'console', 'interfaces'] }).renderShell('dashboard');
  assert.ok(html.includes('page=vouchers'));
  assert.ok(html.includes('page=interfaces'), 'a sub-menu page returns with its group');
  assert.ok(html.includes('id="message-notification"'));
  assert.ok(html.includes('id="console"'));
});

test('login page: placeholders filled, and the password inputs no longer carry name attributes', () => {
  const html = pages().renderLogin();
  assert.ok(html.includes('Sign In| VENDO-ONE'));
  assert.ok(!html.includes('{1}') && !html.includes('{2}'));
  assert.ok(!html.includes('name="admin-password"') && !html.includes('name="admin-username"'));
  assert.ok(html.includes('id="password"') && html.includes('id="username"'), 'the script reads them by id');
  assert.ok(/<form action='\/admin' method='post'>/.test(html), 'the form still posts to /admin');
});

test('hostname is HTML-escaped', () => {
  const html = createPages({ root: ROOT, version: '1', hostname: '<b>"x"</b>' }).renderLogin();
  assert.ok(!html.includes('<b>"x"</b>'));
  assert.ok(html.includes('&lt;B&gt;&quot;X&quot;&lt;/B&gt;'));
});

test('endOfLi balances nested items and throws on broken markup', () => {
  const s = '<li class="a"><ul><li>x</li></ul></li><li>tail</li>';
  assert.equal(s.slice(0, endOfLi(s, 0)), '<li class="a"><ul><li>x</li></ul></li>');
  assert.throws(() => endOfLi('<li><li></li>', 0), /unbalanced/);
});

test('trim helpers leave unrelated html untouched', () => {
  const html = '<p>hello</p><a href="?page=dashboard">brand</a>';
  assert.equal(trimMenu(html, new Set()), html);
  assert.equal(trimNavbar(html, new Set()), html);
  assert.equal(trimProfile(html, ['logout']), html);
  assert.equal(stripLoginNames(html), html);
});

test('the shell carries the leaving-shim exactly once, right after socket.io.js and before the page scripts', () => {
  const html = createPages({ root: ROOT, version: '1', hostname: 'h' }).renderShell('dashboard');
  assert.equal(html.split('var leaving = false;').length - 1, 1);
  const at = (s) => html.indexOf(s);
  assert.ok(at('src="/socket.io.js') < at('var leaving = false;'));
  assert.ok(at('var leaving = false;') < at('src="/nav/script/main.js'));
});

test('a shell without the socket.io.js tag is refused at start-up, not served without the shim', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5ui-'));
  fs.mkdirSync(path.join(root, 'nav'));
  fs.mkdirSync(path.join(root, 'main'));
  fs.writeFileSync(path.join(root, 'nav', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'main', 'index.html'), '<html></html>');
  assert.throws(() => createPages({ root, version: '1', hostname: 'h' }).renderShell('dashboard'), /leaving-shim/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/pages.test.js`
Expected: FAIL, `Cannot find module '../lib/ui/pages'`.

- [ ] **Step 3: Write the implementation**

Create `lib/ui/pages.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

// Pages that work today. Each later sub-project adds its ids here. 'chat' and 'console' are
// not menu pages: they gate the top-bar chat envelope and the web-terminal icon.
const DEFAULT_ENABLED = ['dashboard', 'logs'];

// Profile-menu items that need features this product does not have (remote update from a URL,
// software up/download, data export/import). Hidden until a later sub-project builds them.
const HIDDEN_PROFILE_ITEMS = ['system-update', 'software-updown', 'export-data', 'import-data'];

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

function createPages({ root, version, hostname, enabled = DEFAULT_ENABLED, hiddenProfileItems = HIDDEN_PROFILE_ITEMS }) {
  const on = new Set(enabled);
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const raw = read('nav/index.html');
  if (!raw.includes(SHIM_AFTER)) throw new Error('nav/index.html: the socket.io.js script tag the leaving-shim follows was not found');
  const shell = trimProfile(trimNavbar(trimMenu(raw.replace(SHIM_AFTER, SHIM_AFTER + LEAVING_SHIM), on), on), hiddenProfileItems);
  const login = stripLoginNames(read('main/index.html'));
  const host = escapeHtml(String(hostname).toUpperCase());
  const fill = (html) => html.replace(/\{1\}/g, host).replace(/\{2\}/g, escapeHtml(version));
  return {
    isEnabled: (id) => on.has(id),
    renderLogin: () => fill(login),
    // "@script.js" in the shell is a placeholder for the per-page script, as in the original.
    renderShell: (page) => fill(shell.replace('@script.js', `script/${page}.js`)),
  };
}

module.exports = { createPages, trimMenu, trimNavbar, trimProfile, stripLoginNames, endOfLi, DEFAULT_ENABLED, HIDDEN_PROFILE_ITEMS };
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test test/pages.test.js`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/ui/pages.js test/pages.test.js
git commit -m "feat: page renderer with menu trimming and the leaving-shim

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 4: Account store and offline licence

**Files:**
- Create: `lib/store/account.js`
- Create: `lib/licence.js`
- Create: `test/account.test.js`
- Create: `test/licence.test.js`

**Interfaces:**
- Consumes: 
- Produces: `createAccountStore(file)` returns `{load() (true if it created the factory default), get() ({username,password}), isFactoryDefault(), change({username, oldPassword, newPassword}), reset()}`; `createLicence({stateDir, readFile, writeFile, randomHex})` returns `{deviceId(), licence()}`.

- [ ] **Step 1: Write the failing tests**

Create `test/account.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountStore } = require('../lib/store/account');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5acct-')), 'state', 'account.json');

test('first load creates the factory account, mode 0600, and reports it', () => {
  const file = tmp();
  const a = createAccountStore(file);
  assert.equal(a.load(), true);
  assert.deepEqual(a.get(), { username: 'admin', password: 'admin' });
  assert.equal(a.isFactoryDefault(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { main: { username: 'admin', password: 'admin' } });
});

test('a stored account is loaded back and is not reported as created', () => {
  const file = tmp();
  const a = createAccountStore(file);
  a.load();
  assert.equal(a.change({ username: 'boss', oldPassword: 'admin', newPassword: 'hunter22' }), true);
  const b = createAccountStore(file);
  assert.equal(b.load(), false);
  assert.deepEqual(b.get(), { username: 'boss', password: 'hunter22' });
  assert.equal(b.isFactoryDefault(), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'still 0600 after a rewrite');
});

test('change refuses a wrong old password and empty values, and changes nothing', () => {
  const a = createAccountStore(tmp());
  a.load();
  assert.equal(a.change({ username: 'x', oldPassword: 'nope', newPassword: 'abcdefgh' }), false);
  assert.equal(a.change({ username: 'x', oldPassword: 'admin', newPassword: '' }), false);
  assert.equal(a.change({ username: '', oldPassword: 'admin', newPassword: 'abcdefgh' }), false);
  assert.equal(a.change({ username: 'x', oldPassword: 'admin', newPassword: 42 }), false);
  assert.deepEqual(a.get(), { username: 'admin', password: 'admin' });
});

test('a corrupt or half-formed file is replaced by the factory account, not trusted', () => {
  for (const content of ['{not json', '{}', '{"main":{"username":"x"}}', '[]', '']) {
    const file = tmp();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const a = createAccountStore(file);
    assert.equal(a.load(), true, content);
    assert.equal(a.isFactoryDefault(), true);
  }
});

test('writes are atomic: no temp file is left behind and get() returns a copy', () => {
  const file = tmp();
  const a = createAccountStore(file);
  a.load();
  a.change({ username: 'u', oldPassword: 'admin', newPassword: 'p' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['account.json']);
  a.get().password = 'tampered';
  assert.equal(a.get().password, 'p');
});

test('reset restores the factory account on disk', () => {
  const file = tmp();
  const a = createAccountStore(file);
  a.load();
  a.change({ username: 'u', oldPassword: 'admin', newPassword: 'p' });
  a.reset();
  assert.equal(createAccountStore(file).load(), false);
  assert.equal(a.isFactoryDefault(), true);
});
```

Create `test/licence.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLicence, FOREVER } = require('../lib/licence');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v5lic-'));
const files = (map) => (f) => { if (f in map) return map[f]; throw new Error('ENOENT ' + f); };

test('the licence is permissive: everything on, never expires, huge limits', () => {
  const l = createLicence({ stateDir: dir(), readFile: files({ '/proc/cpuinfo': 'Serial\t\t: 02c000813c3a4a9d\n' }) }).licence();
  assert.equal(l.expiration, FOREVER);
  assert.ok(l.expiration > Date.now() + 1e12);
  assert.ok(l.hotspot >= 1000000 && l.pppoe >= 1000000);
  assert.equal(l.custom_theme, true);
  assert.equal(l.movie, true);
  assert.equal(l.checked, true);
});

test('device id: cpu serial first, then machine-id', () => {
  assert.equal(createLicence({ stateDir: dir(), readFile: files({ '/proc/cpuinfo': 'Hardware\t: x\nSerial\t\t: 02C000813C3A4A9D\n' }) }).deviceId(), '02c000813c3a4a9d');
  assert.equal(createLicence({ stateDir: dir(), readFile: files({ '/proc/cpuinfo': 'Serial\t\t: 0000000000000000\n', '/etc/machine-id': '0123456789abcdef0123456789abcdef\n' }) }).deviceId(), '0123456789abcdef');
});

test('with neither, a random id is created once and persisted', () => {
  const d = dir();
  const onlyState = (f) => { if (f.startsWith(d)) return fs.readFileSync(f, 'utf8'); throw new Error('ENOENT'); };
  const first = createLicence({ stateDir: d, readFile: onlyState, randomHex: () => 'aaaabbbbccccdddd' }).deviceId();
  assert.equal(first, 'aaaabbbbccccdddd');
  assert.equal(fs.readFileSync(path.join(d, 'device-id'), 'utf8').trim(), 'aaaabbbbccccdddd');
  assert.equal(fs.statSync(path.join(d, 'device-id')).mode & 0o777, 0o600);
  const again = createLicence({ stateDir: d, readFile: onlyState, randomHex: () => 'ffffffffffffffff' }).deviceId();
  assert.equal(again, 'aaaabbbbccccdddd', 'the persisted id wins over a new random one');
});

test('an all-zero cpu serial is not a real serial', () => {
  const d = dir();
  const id = createLicence({ stateDir: d, readFile: files({ '/proc/cpuinfo': 'Serial\t: 0000000000000000\n' }), randomHex: () => '1111222233334444' }).deviceId();
  assert.equal(id, '1111222233334444');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/account.test.js test/licence.test.js`
Expected: FAIL, `Cannot find module '../lib/store/account'`.

- [ ] **Step 3: Write the implementation**

Create `lib/store/account.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

const FACTORY = { username: 'admin', password: 'admin' };

// The admin credential. Plaintext on purpose: the original login hashes the typed password with a
// per-login token in the browser, so the server must know the password to recompute the hash.
// The file is mode 0600 and written atomically.
function createAccountStore(file) {
  let main = { ...FACTORY };

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ main }) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // the umask can only remove bits, but be explicit
    fs.renameSync(tmp, file);
  }

  // Returns true when the account had to be (re)created with the factory default.
  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.main && typeof parsed.main.username === 'string' && typeof parsed.main.password === 'string') {
        main = { username: parsed.main.username, password: parsed.main.password };
        return false;
      }
    } catch {
      // missing or corrupt: fall through to the factory default
    }
    main = { ...FACTORY };
    save();
    return true;
  }

  const get = () => ({ ...main });
  const isFactoryDefault = () => main.username === FACTORY.username && main.password === FACTORY.password;

  // The shell sends {username, cnewpass, oldtpass}; it validates length and emoji itself, the
  // server only checks the old password and refuses empty values.
  function change({ username, oldPassword, newPassword }) {
    if (oldPassword !== main.password) return false;
    if (typeof newPassword !== 'string' || newPassword === '' || typeof username !== 'string' || username === '') return false;
    main = { username, password: newPassword };
    save();
    return true;
  }

  function reset() {
    main = { ...FACTORY };
    save();
  }

  return { load, get, isFactoryDefault, change, reset };
}

module.exports = { createAccountStore, FACTORY };
```

Create `lib/licence.js`:

```js
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

// The offline licence: everything enabled, never expires, no network, no signature check. The shape
// mirrors the fields the original frontend and handlers read from its licence object.
const FOREVER = 8640000000000000; // the largest Date value; "expiration" is compared with Date.now()

function createLicence({ stateDir, readFile = (f) => fs.readFileSync(f, 'utf8'), writeFile = fs.writeFileSync, randomHex = () => crypto.randomBytes(8).toString('hex') } = {}) {
  let cached = null;

  function deviceId() {
    if (cached) return cached;
    try {
      const m = /^Serial\s*:\s*([0-9a-fA-F]+)\s*$/m.exec(readFile('/proc/cpuinfo'));
      if (m && /[1-9a-fA-F]/.test(m[1])) return (cached = m[1].toLowerCase());
    } catch { /* no cpuinfo serial */ }
    try {
      const id = readFile('/etc/machine-id').trim();
      if (/^[0-9a-f]{16,}$/i.test(id)) return (cached = id.slice(0, 16).toLowerCase());
    } catch { /* no machine-id */ }
    const file = path.join(stateDir, 'device-id');
    try {
      const id = readFile(file).trim();
      if (/^[0-9a-f]{16}$/.test(id)) return (cached = id);
    } catch { /* first boot */ }
    const id = randomHex();
    fs.mkdirSync(stateDir, { recursive: true });
    writeFile(file, id + '\n', { mode: 0o600 });
    return (cached = id);
  }

  function licence() {
    return { serial: deviceId(), expiration: FOREVER, hotspot: 1000000, pppoe: 1000000, custom_theme: true, movie: true, checked: true };
  }

  return { deviceId, licence };
}

module.exports = { createLicence, FOREVER };
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test test/account.test.js test/licence.test.js`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/store/account.js lib/licence.js test/account.test.js test/licence.test.js
git commit -m "feat: plaintext 0600 account store and offline licence

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 5: Admin sessions and the login-page handlers

**Files:**
- Create: `lib/wire/session.js`
- Create: `lib/wire/main.js`
- Create: `test/wire-main.test.js`

**Interfaces:**
- Consumes: `createAccountStore`, `createLicence` (Task 4); `test/helpers/ui-root.js`.
- Produces: `createSessions({now, ttlMs=3600000, max=500})` returns `{ttlSeconds, create(), get(id), allow(session), destroy(id), size()}`; `createMainHandlers({account, sessions, licence, mainlog, version, now, makeToken})` returns an event table `{ "@main-48931"|"@main-66589"|"@main-66322"|"@main-84472": {handler(payload, ctx), guard, fallback} }`; exports `splitToken, md5, CHALLENGE_WINDOW_MS`.

The md5 in `lib/wire/main.js` hashes `Buffer.from(s, "latin1")` on purpose: the vendor `md5.js` feeds each character's low 8 bits to MD5, not UTF-8 (verified for non-ASCII input). Review Focus 1 is pinned here.

- [ ] **Step 1: Write the failing tests**

Create `test/wire-main.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSessions } = require('../lib/wire/session');
const { createMainHandlers, splitToken } = require('../lib/wire/main');

// The vendor's own browser MD5 (the file the login page loads), run in a sandbox: the client side.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(require('./helpers/ui-root'), 'main', 'js', 'md5.js'), 'utf8'), sandbox);
const hexMD5 = (s) => sandbox.hexMD5(s);

// The login page's own expressions (main/script/main.js), verbatim in meaning.
function browserLogin(token, typedUser, typedPass) {
  return {
    uname: typedUser,
    username: hexMD5(token.substring(0, (token.length - 1) / 2) + typedUser.toLowerCase().replace(/\s/g, '')),
    password: hexMD5(token.substring((token.length - 1) / 2, token.length) + typedPass.replace(/\s/g, '')),
  };
}

function rig({ username = 'admin', password = 'admin', start = 1000000 } = {}) {
  let t = start;
  const writes = [];
  const sessions = createSessions({ now: () => t });
  const account = { get: () => ({ username, password }), change: (a) => { if (a.oldPassword !== password) return false; username = a.username; password = a.newPassword; return true; } };
  const h = createMainHandlers({
    account, sessions, mainlog: { write: (c, l) => writes.push([c, l]) }, version: '9.9.9', licence: { deviceId: () => 'abcdef0123456789' },
    now: () => t, makeToken: () => 'a'.repeat(15) + 'b'.repeat(17),
  });
  const session = sessions.create();
  const ctx = { session, ip: '10.0.0.7' };
  return { h, sessions, session, ctx, writes, advance: (ms) => { t += ms; } };
}

test('the server and the vendor browser MD5 agree on the hash of the same input', () => {
  const { md5 } = require('../lib/wire/main');
  for (const s of ['', 'a', 'admin', 'tokenhalfadmin', 'päss wörd', 'é', 'パス', 'a😀b', 'x'.repeat(200)]) {
    assert.equal(hexMD5(s), md5(s), JSON.stringify(s));
  }
});

test('login succeeds with the browser-computed hashes (typed with spaces and capitals)', () => {
  const r = rig({ username: 'admin', password: 'secret99' });
  const token = r.h['@main-48931'].handler(null, r.ctx);
  assert.equal(token.length, 32);
  const reply = r.h['@main-66589'].handler(browserLogin(token, ' Ad Min ', 'sec ret99'), r.ctx);
  assert.deepEqual(reply, { login: true });
  assert.equal(r.session.allowed, true);
  assert.deepEqual(r.writes[0], ['system', 'Admin Success Login: user  Ad Min  from 10.0.0.7']);
});

test('a non-ASCII password logs in (the browser hashes low bytes, not UTF-8)', () => {
  for (const pw of ['päss wörd1', 'パスワード99', 'pass😀word']) {
    const r = rig({ password: pw });
    const token = r.h['@main-48931'].handler(null, r.ctx);
    assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', pw), r.ctx), { login: true }, pw);
  }
});

test('wrong password and wrong username both fail and are logged', () => {
  const r = rig();
  let token = r.h['@main-48931'].handler(null, r.ctx);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', 'nope'), r.ctx), { login: false });
  token = r.h['@main-48931'].handler(null, r.ctx);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'root', 'admin'), r.ctx), { login: false });
  assert.equal(r.session.allowed, false);
  assert.equal(r.writes.length, 2);
  assert.match(r.writes[0][1], /^Admin Failed Login: user admin invalid user or password from 10\.0\.0\.7$/);
});

test('a token is single-use: replaying the same correct answer fails', () => {
  const r = rig();
  const token = r.h['@main-48931'].handler(null, r.ctx);
  const answer = browserLogin(token, 'admin', 'admin');
  assert.deepEqual(r.h['@main-66589'].handler(answer, r.ctx), { login: true });
  r.session.allowed = false;
  assert.deepEqual(r.h['@main-66589'].handler(answer, r.ctx), { login: false });
});

test('a failed attempt also burns the token', () => {
  const r = rig();
  const token = r.h['@main-48931'].handler(null, r.ctx);
  r.h['@main-66589'].handler(browserLogin(token, 'admin', 'wrong'), r.ctx);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', 'admin'), r.ctx), { login: false });
});

test('the 3 second freshness window: 2999 ms passes, 3000 ms fails', () => {
  let r = rig();
  let token = r.h['@main-48931'].handler(null, r.ctx);
  r.advance(2999);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', 'admin'), r.ctx), { login: true });
  r = rig();
  token = r.h['@main-48931'].handler(null, r.ctx);
  r.advance(3000);
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin(token, 'admin', 'admin'), r.ctx), { login: false });
});

test('verify without asking for a token, or with no session, fails safely', () => {
  const r = rig();
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin('x'.repeat(32), 'admin', 'admin'), r.ctx), { login: false });
  assert.deepEqual(r.h['@main-66589'].handler(browserLogin('x'.repeat(32), 'admin', 'admin'), { session: null, ip: '1.1.1.1' }), { login: false });
  assert.equal(r.h['@main-48931'].handler(null, { session: null }), '');
});

for (const bad of [null, undefined, 'str', 42, [], {}, { username: 1, password: 2 }, { username: 'x' }]) {
  test(`malformed verify payload ${JSON.stringify(bad)} is a failed login, never an exception`, () => {
    const r = rig();
    r.h['@main-48931'].handler(null, r.ctx);
    assert.deepEqual(r.h['@main-66589'].handler(bad, r.ctx), { login: false });
  });
}

test('splitToken matches the browser expression for even and odd lengths', () => {
  for (const len of [31, 32, 1, 2, 3]) {
    const token = 'abcdefghijklmnopqrstuvwxyz012345'.repeat(2).slice(0, len);
    const [a, b] = splitToken(token);
    assert.equal(a, token.substring(0, (token.length - 1) / 2));
    assert.equal(b, token.substring((token.length - 1) / 2, token.length));
  }
  assert.deepEqual(splitToken('x'.repeat(32)).map((s) => s.length), [15, 17], 'substring(15.5, 32) starts at 15, so the second half is the longer one');
});

test('login page version banner and the change-password dialog', () => {
  const r = rig({ password: 'oldpass99' });
  assert.deepEqual(r.h['@main-66322'].handler(null, r.ctx), { version: '9.9.9', prefix: 'abcdef01' });
  assert.equal(r.h['@main-84472'].handler({ username: 'boss', oldtpass: 'wrong', cnewpass: 'newpass99' }, r.ctx), 'Invalid Password');
  assert.equal(r.h['@main-84472'].handler({ username: 'boss', oldtpass: 'oldpass99', cnewpass: 'newpass99' }, r.ctx), 'Success');
  assert.equal(r.h['@main-84472'].handler(null, r.ctx), 'Invalid Password');
});

test('only the change-password event needs a logged-in session', () => {
  const h = rig().h;
  assert.deepEqual(Object.entries(h).map(([id, d]) => [id, d.guard]).sort(), [['@main-48931', false], ['@main-66322', false], ['@main-66589', false], ['@main-84472', true]]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/wire-main.test.js`
Expected: FAIL, `Cannot find module '../lib/wire/session'`.

- [ ] **Step 3: Write the implementation**

Create `lib/wire/session.js`:

```js
const crypto = require('node:crypto');

// In-memory admin sessions, keyed by the cookie id. A session is created on the first GET /admin,
// becomes "allowed" after a successful socket login, and expires one hour after that.
function createSessions({ now = Date.now, ttlMs = 3600000, max = 500 } = {}) {
  const map = new Map();

  const sweep = () => {
    const t = now();
    for (const [id, s] of map) if (s.expiresAt <= t) map.delete(id);
  };

  return {
    ttlSeconds: Math.floor(ttlMs / 1000),
    create() {
      sweep();
      // Anyone on the LAN can request /admin without a cookie; cap the table so that cannot grow it
      // without bound. Maps iterate in insertion order, so the first key is the oldest session.
      while (map.size >= max) map.delete(map.keys().next().value);
      const s = { id: crypto.randomBytes(24).toString('hex'), allowed: false, challenge: null, expiresAt: now() + ttlMs };
      map.set(s.id, s);
      return s;
    },
    get(id) {
      if (typeof id !== 'string' || id === '') return null;
      const s = map.get(id);
      if (!s) return null;
      if (s.expiresAt <= now()) {
        map.delete(id);
        return null;
      }
      return s;
    },
    allow(s) {
      s.allowed = true;
      s.expiresAt = now() + ttlMs;
    },
    destroy(id) {
      map.delete(id);
    },
    size() {
      sweep();
      return map.size;
    },
  };
}

module.exports = { createSessions };
```

Create `lib/wire/main.js`:

```js
const crypto = require('node:crypto');

// The browser hashes with the vendor's md5.js, which feeds each character's low 8 bits to MD5 (not
// UTF-8). 'latin1' is exactly that, so a password such as "päss" or "パス" hashes identically on both
// sides. Hashing UTF-8 here would lock out any admin whose password has a non-ASCII character.
const md5 = (s) => crypto.createHash('md5').update(Buffer.from(s, 'latin1')).digest('hex');
const CHALLENGE_WINDOW_MS = 3000;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The browser splits the token with these exact expressions; for an odd length (1/2 is fractional)
// substring() truncates, so both halves are computed the same way here.
function splitToken(token) {
  const mid = (token.length - 1) / 2;
  return [token.substring(0, mid), token.substring(mid, token.length)];
}

// Handlers for the login page (@main-*). Each is (payload, ctx) => reply; ctx = { session, ip }.
function createMainHandlers({ account, sessions, licence, mainlog, version, now = Date.now, makeToken = () => crypto.randomBytes(16).toString('hex') }) {
  const log = (text) => { if (mainlog) mainlog.write('system', text); };

  return {
    // The login page asks for a token; the browser hashes the typed credentials with its two halves.
    '@main-48931': {
      guard: false,
      fallback: '',
      handler(_payload, ctx) {
        if (!ctx.session) return '';
        const token = makeToken();
        ctx.session.challenge = { token, at: now() };
        return token;
      },
    },

    '@main-66589': {
      guard: false,
      fallback: { login: false },
      handler(payload, ctx) {
        const p = payload && typeof payload === 'object' ? payload : {};
        const name = typeof p.uname === 'string' ? p.uname : '';
        const session = ctx.session;
        const ch = session && session.challenge;
        if (session) session.challenge = null; // one attempt per token, pass or fail
        let ok = false;
        if (ch && now() - ch.at < CHALLENGE_WINDOW_MS) {
          const [a, b] = splitToken(ch.token);
          const acc = account.get();
          ok = safeEqual(p.username, md5(a + acc.username.toLowerCase().replace(/\s/g, ''))) && safeEqual(p.password, md5(b + acc.password.replace(/\s/g, '')));
        }
        if (ok) {
          sessions.allow(session);
          log(`Admin Success Login: user ${name} from ${ctx.ip}`);
        } else {
          log(`Admin Failed Login: user ${name} invalid user or password from ${ctx.ip}`);
        }
        return { login: ok };
      },
    },

    // Shown on the login page as "Version: x" and "Code: y".
    '@main-66322': {
      guard: false,
      fallback: {},
      handler: () => ({ version, prefix: licence.deviceId().slice(0, 8) }),
    },

    // The shell's change-password dialog sends {username, cnewpass, oldtpass} and shows the reply text.
    '@main-84472': {
      guard: true,
      fallback: 'Error',
      handler(payload) {
        const p = payload && typeof payload === 'object' ? payload : {};
        const ok = account.change({ username: p.username, oldPassword: p.oldtpass, newPassword: p.cnewpass });
        if (ok) log('Admin account changed');
        return ok ? 'Success' : 'Invalid Password';
      },
    },
  };
}

module.exports = { createMainHandlers, splitToken, md5, CHALLENGE_WINDOW_MS };
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test test/wire-main.test.js`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/wire/session.js lib/wire/main.js test/wire-main.test.js
git commit -m "feat: admin sessions and the login challenge/response handlers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 6: The socket server, the /admin routes, and the whole login

**Files:**
- Create: `lib/wire/server.js`
- Create: `lib/ui/admin-routes.js`
- Create: `test/wire-server.test.js`
- Create: `test/admin-routes.test.js`
- Create: `test/login-flow.test.js`

**Interfaces:**
- Consumes: Tasks 2, 3, 5.
- Produces: `attachWire(httpServer, {events, sessions, log, cookieName})` mounts socket.io at `/admin`, answers a bare `/admin/` with a 302 to `/admin?page=dashboard`, binds each socket to its cookie session, enforces each event's `guard`, answers `fallback` when a handler throws; exports `parseCookies, ipOf, COOKIE`. `createAdminRoutes({pages, sessions, serveStatic})` returns `handle(req, res)` (`true` when answered).

`login-flow.test.js` runs the **vendor** `main/js/md5.js` in a `vm` as the browser-side hasher, against the real pages, routes, sessions and handlers. Review Focus 1 and 5 are pinned here.

- [ ] **Step 1: Write the failing tests**

Create `test/wire-server.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const { createSessions } = require('../lib/wire/session');
const { attachWire } = require('../lib/wire/server');

async function rig(events, { now } = {}) {
  const clock = { t: 1000000 };
  const sessions = createSessions({ now: now || (() => clock.t) });
  const logs = [];
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('PAGE ' + req.url); });
  const io = attachWire(server, { events, sessions, log: (...a) => logs.push(a) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const open = (cookie, extra = {}) => new Promise((resolve, reject) => {
    const c = connect('http://127.0.0.1:' + port, { path: '/admin', reconnection: false, transports: ['websocket'], extraHeaders: cookie ? { cookie: `vendo5_sid=${cookie}` } : {}, ...extra });
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
  const get = (p) => new Promise((resolve) => http.get({ port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, loc: r.headers.location, body: b })); }));
  const stop = () => { io.close(); server.close(); };
  return { sessions, logs, open, get, stop, clock, port };
}
const ask = (c, id, payload) => new Promise((resolve) => c.emit(id, payload, resolve));
const disconnected = (c) => new Promise((resolve) => (c.connected ? c.once('disconnect', resolve) : resolve()));

test('page routes are untouched; a bare /admin/ goes to the dashboard like the original nginx did', async () => {
  const r = await rig({});
  try {
    assert.equal((await r.get('/admin')).body, 'PAGE /admin');
    assert.equal((await r.get('/admin?page=logs')).body, 'PAGE /admin?page=logs');
    const bare = await r.get('/admin/');
    assert.equal(bare.status, 302);
    assert.equal(bare.loc, '/admin?page=dashboard');
    assert.equal((await r.get('/admin/?x=1')).status, 302);
    assert.equal((await r.get('/theme/a.css')).body, 'PAGE /theme/a.css');
  } finally { r.stop(); }
});

test('an unguarded event works without a session; the reply comes back through the ack', async () => {
  const r = await rig({ '@t-open': { guard: false, fallback: 'F', handler: (p, ctx) => ({ echo: p, hasSession: !!ctx.session }) } });
  try {
    const c = await r.open('');
    assert.deepEqual(await ask(c, '@t-open', { a: 1 }), { echo: { a: 1 }, hasSession: false });
    c.close();
  } finally { r.stop(); }
});

test('a guarded event is refused without a login: the socket is disconnected and the handler never runs', async () => {
  let ran = 0;
  const r = await rig({ '@t-guard': { guard: true, fallback: 'F', handler: () => { ran++; return 'ok'; } } });
  try {
    for (const cookie of ['', 'forged', r.sessions.create().id]) { // no cookie, unknown cookie, a real but not-logged-in session
      const c = await r.open(cookie);
      const gone = disconnected(c);
      c.emit('@t-guard', {}, () => { ran++; });
      await gone;
    }
    assert.equal(ran, 0);
  } finally { r.stop(); }
});

test('a logged-in session runs guarded events, and sees its own session and the client ip', async () => {
  const r = await rig({ '@t-guard': { guard: true, fallback: 'F', handler: (p, ctx) => ({ sid: ctx.session.id, ip: ctx.ip }) } });
  try {
    const s = r.sessions.create();
    r.sessions.allow(s);
    const c = await r.open(s.id, { extraHeaders: { cookie: `vendo5_sid=${s.id}`, 'x-forwarded-for': '10.0.0.9, 192.168.1.1' } });
    assert.deepEqual(await ask(c, '@t-guard', {}), { sid: s.id, ip: '10.0.0.9' });
    c.close();
  } finally { r.stop(); }
});

test('the session expiring while connected takes effect on the very next event', async () => {
  const r = await rig({ '@t-guard': { guard: true, fallback: 'F', handler: () => 'ok' } });
  try {
    const s = r.sessions.create();
    r.sessions.allow(s);
    const c = await r.open(s.id);
    assert.equal(await ask(c, '@t-guard', {}), 'ok');
    r.clock.t += 3600001;
    const gone = disconnected(c);
    c.emit('@t-guard', {}, () => {});
    await gone;
  } finally { r.stop(); }
});

test('a handler that throws is logged and the client gets the fallback, not an exception', async () => {
  const r = await rig({
    '@t-boom': { guard: false, fallback: { err: 'x' }, handler: () => { throw new Error('boom'); } },
    '@t-reject': { guard: false, fallback: 'rejected', handler: async () => { throw new Error('async boom'); } },
  });
  try {
    const c = await r.open('');
    assert.deepEqual(await ask(c, '@t-boom', {}), { err: 'x' });
    assert.equal(await ask(c, '@t-reject', {}), 'rejected');
    assert.deepEqual(r.logs.map((l) => [l[0], l[1], l[2].error]), [['error', 'wire handler @t-boom failed', 'boom'], ['error', 'wire handler @t-reject failed', 'async boom']]);
    assert.equal(c.connected, true, 'the socket survives');
    c.close();
  } finally { r.stop(); }
});

test('async handlers are awaited; a payload-less emit with only a callback passes undefined', async () => {
  const r = await rig({ '@t-async': { guard: false, fallback: 'F', handler: async (p) => { await new Promise((x) => setTimeout(x, 20)); return typeof p; } } });
  try {
    const c = await r.open('');
    assert.equal(await new Promise((resolve) => c.emit('@t-async', resolve)), 'undefined');
    c.close();
  } finally { r.stop(); }
});

test('unknown events and events without a callback are harmless', async () => {
  let seen = 0;
  const r = await rig({ '@t-fire': { guard: false, fallback: 'F', handler: () => { seen++; return 1; } } });
  try {
    const c = await r.open('');
    c.emit('@nobody-handles-this', { x: 1 });
    c.emit('@t-fire', { x: 1 }); // no ack function
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(seen, 1);
    assert.equal(c.connected, true);
    c.close();
  } finally { r.stop(); }
});

test('polling transport works too (the original client lists websocket first, polling as fallback)', async () => {
  const r = await rig({ '@t-open': { guard: false, fallback: 'F', handler: () => 'ok' } });
  try {
    const c = await r.open('', { transports: ['polling'] });
    assert.equal(await ask(c, '@t-open', {}), 'ok');
    c.close();
  } finally { r.stop(); }
});
```

Create `test/admin-routes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { createPages } = require('../lib/ui/pages');
const { createStatic } = require('../lib/ui/static');
const { createSessions } = require('../lib/wire/session');
const { createAdminRoutes } = require('../lib/ui/admin-routes');

const ROOT = require('./helpers/ui-root');

async function rig() {
  const sessions = createSessions();
  const pages = createPages({ root: ROOT, version: '1.2.3', hostname: 'vendo' });
  const handle = createAdminRoutes({ pages, sessions, serveStatic: createStatic({ root: ROOT }) });
  const server = http.createServer((req, res) => { if (!handle(req, res)) res.writeHead(200, { 'Content-Type': 'text/plain' }).end('FALLTHROUGH'); });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const call = (method, p, { cookie, body, type } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = type || 'application/json';
    const req = http.request({ port, method, path: p, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { sessions, call, stop: () => server.close() };
}
const loggedIn = (r) => { const s = r.sessions.create(); r.sessions.allow(s); return `vendo5_sid=${s.id}`; };

test('GET /admin without a cookie: the login page and a hardened session cookie', async () => {
  const r = await rig();
  try {
    const res = await r.call('GET', '/admin');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(res.body.includes('Sign In| VENDO'));
    const ck = res.headers['set-cookie'][0];
    for (const part of ['vendo5_sid=', 'HttpOnly', 'SameSite=Strict', 'Path=/admin', 'Max-Age=3600']) assert.ok(ck.includes(part), part + ' in ' + ck);
    assert.equal(r.sessions.size(), 1);
  } finally { r.stop(); }
});

test('GET /admin with an existing logged-out session reuses it (no new cookie, no new session)', async () => {
  const r = await rig();
  try {
    const s = r.sessions.create();
    const res = await r.call('GET', '/admin?page=dashboard', { cookie: `vendo5_sid=${s.id}` });
    assert.ok(res.body.includes('Sign In|'), 'logged out: the page param is ignored');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(r.sessions.size(), 1);
  } finally { r.stop(); }
});

test('logged in: the shell for an enabled page, a redirect for a missing or disabled one', async () => {
  const r = await rig();
  try {
    const cookie = loggedIn(r);
    const shell = await r.call('GET', '/admin?page=logs', { cookie });
    assert.equal(shell.status, 200);
    assert.ok(shell.body.includes('/nav/script/logs.js?version=1.2.3'));
    for (const url of ['/admin', '/admin?page=vouchers', '/admin?page=eload-sales', '/admin?page=', '/admin?page=../../etc', '/admin?page=<script>', '/admin?page=dashboard%00']) {
      const res = await r.call('GET', url, { cookie });
      assert.equal(res.status, 302, url);
      assert.equal(res.headers.location, '/admin?page=dashboard', url);
    }
    assert.equal((await r.call('GET', '/admin?page=dashboard', { cookie })).status, 200);
  } finally { r.stop(); }
});

test('POST /admin from the login form: redirect to the dashboard only when logged in', async () => {
  const r = await rig();
  try {
    const out = await r.call('POST', '/admin', { body: '', type: 'application/x-www-form-urlencoded' });
    assert.equal(out.status, 302);
    assert.equal(out.headers.location, '/admin');
    const notYet = r.sessions.create();
    assert.equal((await r.call('POST', '/admin', { cookie: `vendo5_sid=${notYet.id}`, body: 'x=1', type: 'application/x-www-form-urlencoded' })).headers.location, '/admin');
    const res = await r.call('POST', '/admin', { cookie: loggedIn(r), body: '', type: 'application/x-www-form-urlencoded' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin?page=dashboard');
  } finally { r.stop(); }
});

test('POST /admin {logout:true} ends the session and clears the cookie; the next GET is the login page', async () => {
  const r = await rig();
  try {
    const cookie = loggedIn(r);
    const res = await r.call('POST', '/admin?', { cookie, body: JSON.stringify({ logout: true }) });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{}');
    assert.match(res.headers['set-cookie'][0], /Max-Age=0/);
    assert.ok((await r.call('GET', '/admin?page=dashboard', { cookie })).body.includes('Sign In|'));
  } finally { r.stop(); }
});

test('POST /admin tolerates junk and oversized bodies', async () => {
  const r = await rig();
  try {
    for (const body of ['{{{{', 'null', '[1]', '"x"', 'x'.repeat(100000)]) {
      const res = await r.call('POST', '/admin', { body });
      assert.equal(res.status, 302, body.slice(0, 10));
    }
    assert.equal((await r.call('GET', '/admin')).status, 200);
  } finally { r.stop(); }
});

test('static assets are served through the same handler; raw html and other methods fall through', async () => {
  const r = await rig();
  try {
    const js = await r.call('GET', '/nav/script/dashboard.js?version=1');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.equal((await r.call('GET', '/socket.io.js?version=1')).status, 200);
    assert.equal((await r.call('GET', '/nav/index.html')).body, 'FALLTHROUGH');
    assert.equal((await r.call('PUT', '/admin', { body: '{}' })).body, 'FALLTHROUGH');
    assert.equal((await r.call('DELETE', '/admin')).body, 'FALLTHROUGH');
  } finally { r.stop(); }
});
```

Create `test/login-flow.test.js`:

```js
// The whole login the way a browser does it, against the real pages, routes, sessions and handlers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { io: connect } = require('socket.io-client');
const { createPages } = require('../lib/ui/pages');
const { createStatic } = require('../lib/ui/static');
const { createSessions } = require('../lib/wire/session');
const { createAdminRoutes } = require('../lib/ui/admin-routes');
const { attachWire } = require('../lib/wire/server');
const { createMainHandlers } = require('../lib/wire/main');

const ROOT = require('./helpers/ui-root');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'main', 'js', 'md5.js'), 'utf8'), sandbox);

async function rig(password = 'secret99') {
  const sessions = createSessions();
  const pages = createPages({ root: ROOT, version: '1.2.3', hostname: 'vendo' });
  const handle = createAdminRoutes({ pages, sessions, serveStatic: createStatic({ root: ROOT }) });
  const server = http.createServer((req, res) => { if (!handle(req, res)) res.writeHead(404).end(); });
  const account = { get: () => ({ username: 'admin', password }), change: () => false };
  const events = createMainHandlers({ account, sessions, licence: { deviceId: () => 'abcdef0123456789' }, version: '1.2.3' });
  const io = attachWire(server, { events, sessions });
  await new Promise((r) => server.listen(0, r));
  return { sessions, port: server.address().port, stop: () => { io.close(); server.close(); } };
}
const req = (port, method, p, { cookie, body, type } = {}) => new Promise((resolve, reject) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = type;
  const q = http.request({ port, method, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  q.on('error', reject);
  q.end(body);
});
const open = (port, cookie) => new Promise((resolve, reject) => {
  const c = connect('http://127.0.0.1:' + port, { path: '/admin', reconnection: false, transports: ['websocket', 'polling'], extraHeaders: { cookie } });
  c.on('connect', () => resolve(c));
  c.on('connect_error', reject);
});
const ask = (c, id, payload) => new Promise((resolve) => (payload === undefined ? c.emit(id, resolve) : c.emit(id, payload, resolve)));

async function browserLogin(port, user, pass) {
  const page = await req(port, 'GET', '/admin');
  const cookie = page.headers['set-cookie'][0].split(';')[0];
  const sock = await open(port, cookie);
  const token = await ask(sock, '@main-48931'); // the page sends an emit with only a callback
  const answer = {
    uname: user,
    username: sandbox.hexMD5(token.substring(0, (token.length - 1) / 2) + user.toLowerCase().replace(/\s/g, '')),
    password: sandbox.hexMD5(token.substring((token.length - 1) / 2, token.length) + pass.replace(/\s/g, '')),
  };
  const reply = await ask(sock, '@main-66589', answer);
  sock.close();
  return { cookie, reply };
}

test('full browser login: login page, socket challenge, form post, shell', async () => {
  const r = await rig();
  try {
    const { cookie, reply } = await browserLogin(r.port, 'Admin', 'secret99');
    assert.deepEqual(reply, { login: true });
    const submit = await req(r.port, 'POST', '/admin', { cookie, body: '', type: 'application/x-www-form-urlencoded' });
    assert.equal(submit.status, 302);
    assert.equal(submit.headers.location, '/admin?page=dashboard');
    const shell = await req(r.port, 'GET', '/admin?page=dashboard', { cookie });
    assert.equal(shell.status, 200);
    assert.ok(shell.body.includes('/nav/script/dashboard.js?version=1.2.3'));
  } finally { r.stop(); }
});

test('wrong password: the form post bounces back to the login page and no shell is served', async () => {
  const r = await rig();
  try {
    const { cookie, reply } = await browserLogin(r.port, 'admin', 'wrong');
    assert.deepEqual(reply, { login: false });
    assert.equal((await req(r.port, 'POST', '/admin', { cookie, body: '', type: 'application/x-www-form-urlencoded' })).headers.location, '/admin');
    assert.ok((await req(r.port, 'GET', '/admin?page=dashboard', { cookie })).body.includes('Sign In|'));
  } finally { r.stop(); }
});

test('the login page form can no longer post a plaintext password', async () => {
  const r = await rig();
  try {
    const page = (await req(r.port, 'GET', '/admin')).body;
    assert.ok(!/name="admin-(username|password)"/.test(page));
  } finally { r.stop(); }
});

test('a socket that connects without the page cookie cannot log in a browser that has one', async () => {
  const r = await rig();
  try {
    const page = await req(r.port, 'GET', '/admin');
    const cookie = page.headers['set-cookie'][0].split(';')[0];
    const stranger = await open(r.port, 'vendo5_sid=forged');
    assert.equal(await ask(stranger, '@main-48931'), '', 'no session, no token');
    stranger.close();
    assert.ok((await req(r.port, 'GET', '/admin?page=dashboard', { cookie })).body.includes('Sign In|'));
  } finally { r.stop(); }
});

test('logout from the shell ends the session', async () => {
  const r = await rig();
  try {
    const { cookie } = await browserLogin(r.port, 'admin', 'secret99');
    assert.equal((await req(r.port, 'GET', '/admin?page=dashboard', { cookie })).status, 200);
    assert.equal((await req(r.port, 'POST', '/admin?', { cookie, body: '{"logout":true}', type: 'application/json' })).status, 200);
    assert.ok((await req(r.port, 'GET', '/admin?page=dashboard', { cookie })).body.includes('Sign In|'));
  } finally { r.stop(); }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/wire-server.test.js test/admin-routes.test.js test/login-flow.test.js`
Expected: FAIL, `Cannot find module '../lib/wire/server'`.

- [ ] **Step 3: Write the implementation**

Create `lib/wire/server.js`:

```js
const { Server } = require('socket.io');

const COOKIE = 'vendo5_sid';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function ipOf(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  const raw = (fwd ? String(fwd).split(',')[0].trim() : socket.handshake.address) || '';
  return raw.replace(/^::ffff:/, '');
}

// Mounts socket.io at /admin (the path the original frontend connects to) and routes each event id
// through the table. events: { '<id>': { handler(payload, ctx), guard, fallback } }.
//   guard: the session must be logged in and unexpired, else the socket is disconnected and the
//          handler never runs (the original's per-event expiry check).
//   fallback: what the client is answered if the handler throws (handlers never throw into the socket).
function attachWire(httpServer, { events, sessions, log = () => {}, cookieName = COOKIE }) {
  const io = new Server({ path: '/admin', serveClient: false, transports: ['websocket', 'polling'], maxHttpBufferSize: 262144 });
  io.attach(httpServer);

  // engine.io now owns every request under "/admin/". The original nginx redirected a bare "/admin/"
  // (no EIO query) to the dashboard; do the same before engine.io can answer it with a 400.
  const wired = httpServer.listeners('request').slice();
  httpServer.removeAllListeners('request');
  httpServer.on('request', (req, res) => {
    if (req.url.startsWith('/admin/') && !/[?&]EIO=/.test(req.url)) {
      res.writeHead(302, { Location: '/admin?page=dashboard' }).end();
      return;
    }
    for (const l of wired) l.call(httpServer, req, res);
  });

  io.use((socket, next) => {
    socket.data.sid = parseCookies(socket.request.headers.cookie)[cookieName] || '';
    next();
  });

  io.on('connection', (socket) => {
    for (const [id, def] of Object.entries(events)) {
      socket.on(id, async (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
        const session = sessions.get(socket.data.sid); // resolved per event so an expiry takes effect at once
        if (def.guard && !(session && session.allowed)) {
          socket.disconnect(true);
          return;
        }
        try {
          ack(await def.handler(args[0], { session, socket, ip: ipOf(socket) }));
        } catch (e) {
          log('error', `wire handler ${id} failed`, { error: e && e.message });
          ack(def.fallback);
        }
      });
    }
  });

  return io;
}

module.exports = { attachWire, parseCookies, ipOf, COOKIE };
```

Create `lib/ui/admin-routes.js`:

```js
const { parseCookies, COOKIE } = require('../wire/server');

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
function createAdminRoutes({ pages, sessions, serveStatic }) {
  const cookieHeader = (id, seconds) => `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${seconds}`;
  const html = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  const redirect = (res, location, extra = {}) => res.writeHead(302, { Location: location, ...extra }).end();

  async function post(req, res) {
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
    const page = url.searchParams.get('page');
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
      if (req.method === 'POST') { post(req, res); return true; }
      return false;
    }
    return serveStatic(req, res);
  };
}

module.exports = { createAdminRoutes };
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test test/wire-server.test.js test/admin-routes.test.js test/login-flow.test.js`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/wire/server.js lib/ui/admin-routes.js test/wire-server.test.js test/admin-routes.test.js test/login-flow.test.js
git commit -m "feat: socket.io wire server and /admin routes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 7: Main log files

**Files:**
- Create: `lib/system/mainlog.js`
- Create: `test/mainlog.test.js`

**Interfaces:**
- Consumes: 
- Produces: `createMainLog({dir, now, maxPerCategory=30, fs})` returns `{write(category, text) (never throws; returns boolean), list(), read(name), remove(name) ({success, err?}), removeByCategory(category) ({success, removed?})}`; exports `FILE`.

Review Focus 3 is pinned here (newline forgery, traversal, odd names).

- [ ] **Step 1: Write the failing tests**

Create `test/mainlog.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMainLog } = require('../lib/system/mainlog');

const dir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5log-')), 'mainlogs');
const at = (iso) => () => new Date(iso);

test('a line lands in <category>-DD-MM-YYYY.txt as "hh:mm:ss am|pm: text"', () => {
  const d = dir();
  const log = createMainLog({ dir: d, now: at('2026-10-05T09:07:03') });
  assert.equal(log.write('system', 'Admin Success Login: user admin from 10.0.0.2'), true);
  assert.deepEqual(fs.readdirSync(d), ['system-05-10-2026.txt']);
  assert.equal(fs.readFileSync(path.join(d, 'system-05-10-2026.txt'), 'utf8'), '09:07:03 am: Admin Success Login: user admin from 10.0.0.2\n');
});

test('12-hour clock edge cases: midnight, noon, 1 pm', () => {
  const d = dir();
  for (const [iso, want] of [['2026-01-02T00:05:00', '12:05:00 am'], ['2026-01-02T12:00:00', '12:00:00 pm'], ['2026-01-02T13:30:09', '01:30:09 pm'], ['2026-01-02T23:59:59', '11:59:59 pm']]) {
    createMainLog({ dir: d, now: at(iso) }).write('system', 'x');
  }
  const lines = fs.readFileSync(path.join(d, 'system-02-01-2026.txt'), 'utf8').trim().split('\n').map((l) => l.split(': ')[0]);
  assert.deepEqual(lines, ['12:05:00 am', '12:00:00 pm', '01:30:09 pm', '11:59:59 pm']);
});

test('the same day appends; a new day makes a new file; categories may contain a hyphen', () => {
  const d = dir();
  createMainLog({ dir: d, now: at('2026-10-05T10:00:00') }).write('system', 'a');
  createMainLog({ dir: d, now: at('2026-10-05T11:00:00') }).write('system', 'b');
  createMainLog({ dir: d, now: at('2026-10-06T11:00:00') }).write('system', 'c');
  createMainLog({ dir: d, now: at('2026-10-06T11:00:00') }).write('phone-rental', 'd');
  const log = createMainLog({ dir: d });
  assert.deepEqual(log.list(), ['system-05-10-2026.txt', 'phone-rental-06-10-2026.txt', 'system-06-10-2026.txt'], 'oldest day first, then by name');
  assert.equal(log.read('system-05-10-2026.txt').split('\n').filter(Boolean).length, 2);
});

test('a log line is always one line: newlines in the text cannot forge entries', () => {
  const d = dir();
  createMainLog({ dir: d, now: at('2026-10-05T10:00:00') }).write('system', 'real\n10:00:01 am: Admin Success Login: user root\r\nmore');
  const lines = fs.readFileSync(path.join(d, 'system-05-10-2026.txt'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
});

test('retention: at most N files per category, oldest removed first, other categories untouched', () => {
  const d = dir();
  for (let day = 1; day <= 6; day++) createMainLog({ dir: d, now: at(`2026-10-0${day}T10:00:00`), maxPerCategory: 3 }).write('system', 'x');
  createMainLog({ dir: d, now: at('2026-10-01T10:00:00'), maxPerCategory: 3 }).write('voucher', 'v');
  assert.deepEqual(createMainLog({ dir: d }).list().filter((n) => n.startsWith('system')), ['system-04-10-2026.txt', 'system-05-10-2026.txt', 'system-06-10-2026.txt']);
  assert.ok(createMainLog({ dir: d }).list().includes('voucher-01-10-2026.txt'));
});

test('retention orders by date, not by name (month rollover, year rollover)', () => {
  const d = dir();
  for (const iso of ['2025-12-31T10:00:00', '2026-01-01T10:00:00', '2026-01-02T10:00:00']) createMainLog({ dir: d, now: at(iso), maxPerCategory: 2 }).write('system', 'x');
  assert.deepEqual(createMainLog({ dir: d }).list(), ['system-01-01-2026.txt', 'system-02-01-2026.txt']);
});

test('read and remove only accept real log file names (no traversal, no other files)', () => {
  const d = dir();
  const log = createMainLog({ dir: d, now: at('2026-10-05T10:00:00') });
  log.write('system', 'x');
  fs.writeFileSync(path.join(path.dirname(d), 'secret.txt'), 'secret');
  for (const bad of ['../secret.txt', '../../etc/passwd', 'system-05-10-2026.txt/../../secret.txt', 'secret.txt', '', null, undefined, 5, {}, 'system-5-10-2026.txt']) {
    assert.equal(log.read(bad), '', String(bad));
    assert.equal(log.remove(bad).success, false, String(bad));
  }
  assert.ok(fs.existsSync(path.join(path.dirname(d), 'secret.txt')));
  assert.equal(log.read('system-05-10-2026.txt'), '10:00:00 am: x\n');
  assert.deepEqual(log.remove('system-05-10-2026.txt'), { success: true });
  assert.equal(log.remove('system-05-10-2026.txt').success, false, 'already gone');
});

test('removeByCategory deletes only that category', () => {
  const d = dir();
  for (const c of ['system', 'voucher', 'phone-rental']) createMainLog({ dir: d, now: at('2026-10-05T10:00:00') }).write(c, 'x');
  const log = createMainLog({ dir: d });
  assert.deepEqual(log.removeByCategory('voucher'), { success: true, removed: 1 });
  assert.deepEqual(log.list(), ['phone-rental-05-10-2026.txt', 'system-05-10-2026.txt']);
  assert.equal(log.removeByCategory('../x').success, false);
  assert.equal(log.removeByCategory('system-05').success, false);
});

test('writing never throws, even when the directory cannot be created or the category is odd', () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5log-')), 'file');
  fs.writeFileSync(blocker, 'x');
  assert.equal(createMainLog({ dir: path.join(blocker, 'sub') }).write('system', 'x'), false);
  const d = dir();
  assert.equal(createMainLog({ dir: d, now: at('2026-10-05T10:00:00') }).write('../../evil', 'x'), true);
  assert.deepEqual(fs.readdirSync(d), ['system-05-10-2026.txt'], 'an invalid category falls back to system');
});

test('listing a missing directory is just empty', () => {
  assert.deepEqual(createMainLog({ dir: '/nonexistent-v5-dir' }).list(), []);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/mainlog.test.js`
Expected: FAIL, `Cannot find module '../lib/system/mainlog'`.

- [ ] **Step 3: Write the implementation**

Create `lib/system/mainlog.js`:

```js
const nodeFs = require('node:fs');
const path = require('node:path');

// "<category>-<DD>-<MM>-<YYYY>.txt": the format the Logs page parses (it strips "<category>-" and
// ".txt", then orders by year, month, day). Categories may contain hyphens ("phone-rental").
const FILE = /^([A-Za-z][A-Za-z-]*)-(\d{2})-(\d{2})-(\d{4})\.txt$/;
const CATEGORY = /^[A-Za-z][A-Za-z-]*$/;
const pad = (n) => String(n).padStart(2, '0');

function createMainLog({ dir, now = () => new Date(), maxPerCategory = 30, fs = nodeFs }) {
  const sortKey = (name) => {
    const m = FILE.exec(name);
    return m[4] + m[3] + m[2]; // YYYYMMDD
  };

  function listAll() {
    try {
      return fs.readdirSync(dir).filter((n) => FILE.test(n)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.localeCompare(b));
    } catch {
      return [];
    }
  }

  // One line per entry, newest appended last: "<hh:mm:ss am|pm>: <text>" (the page highlights the time).
  function write(category, text) {
    try {
      const cat = CATEGORY.test(category) ? category : 'system';
      const d = now();
      const h = d.getHours();
      const time = `${pad(h % 12 || 12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h < 12 ? 'am' : 'pm'}`;
      const file = `${cat}-${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}.txt`;
      fs.mkdirSync(dir, { recursive: true });
      // a log line is one line: never let the text forge another
      fs.appendFileSync(path.join(dir, file), `${time}: ${String(text).replace(/[\r\n]+/g, ' ')}\n`);
      const mine = listAll().filter((n) => FILE.exec(n)[1] === cat);
      for (const old of mine.slice(0, Math.max(0, mine.length - maxPerCategory))) fs.unlinkSync(path.join(dir, old)); // flash must not fill
      return true;
    } catch {
      return false; // logging never takes the app down (full or read-only disk)
    }
  }

  const list = () => listAll();

  function read(name) {
    if (typeof name !== 'string' || !FILE.test(name)) return '';
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return '';
    }
  }

  function remove(name) {
    if (typeof name !== 'string' || !FILE.test(name)) return { success: false, err: 'invalid file name' };
    try {
      fs.unlinkSync(path.join(dir, name));
      return { success: true };
    } catch (e) {
      return { success: false, err: e.message };
    }
  }

  function removeByCategory(category) {
    if (typeof category !== 'string' || !CATEGORY.test(category)) return { success: false, err: 'invalid category' };
    let removed = 0;
    for (const n of listAll()) {
      if (FILE.exec(n)[1] === category && remove(n).success) removed++;
    }
    return { success: true, removed };
  }

  return { write, list, read, remove, removeByCategory };
}

module.exports = { createMainLog, FILE };
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test test/mainlog.test.js`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/system/mainlog.js test/mainlog.test.js
git commit -m "feat: dated main log files with retention

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 8: Stats, command passthrough, notifications

**Files:**
- Create: `lib/system/stats.js`
- Create: `lib/wire/passthrough.js`
- Create: `lib/store/notifications.js`
- Create: `test/stats.test.js`
- Create: `test/passthrough.test.js`
- Create: `test/notifications.test.js`

**Interfaces:**
- Consumes: 
- Produces: `createStats({fs, runCommand, statfs, userDir})` returns `{snapshot(), systemInfo()}`; `createPassthrough({runCommand, reboot, systemInfo})` returns `run(line) => object` (allowlist: `ubus call system info`, `ubus call network.interface.(wan|wan2|wg0) status`, `ubus call system reboot`; anything else is `{}` without running anything); `createNotifications({file, now})` returns `{list(), add({title, icon, message}), markRead(date), clear()}`.

Contract facts recorded from the live page (a `Proxy` around every reply listed each property the page read): notification keys are epoch **milliseconds** (the page `parseInt`s the key for the date) and the body field is `message`; `ubus call system info` must answer an `uptime` or the dashboard prints `NaN:NaN:NaN`, so a host without `ubus` gets the same figures from `/proc`.

- [ ] **Step 1: Write the failing tests**

Create `test/stats.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createStats } = require('../lib/system/stats');

const files = (map) => ({ readFileSync: (f) => { if (f in map) return map[f]; throw new Error('ENOENT'); } });
const STAT1 = 'cpu  100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0\n';
const STAT2 = 'cpu  200 0 200 1000 0 0 0 0\ncpu0 150 0 150 400 0 0 0 0\ncpu1 50 0 50 600 0 0 0 0\n';

test('cpuusage: per-core deltas then the overall figure last; first sample is 0', () => {
  let stat = STAT1;
  const s = createStats({ fs: { readFileSync: (f) => (f === '/proc/stat' ? stat : (() => { throw new Error('x'); })()) } });
  assert.deepEqual(s.snapshot().cpuusage, [0, 0, 0]);
  stat = STAT2;
  assert.deepEqual(s.snapshot().cpuusage, [100, 0, 50]);
});

test('ram in bytes (MemAvailable preferred), temperature in °C, cpuinfo from /proc and cpufreq', () => {
  const s = createStats({ fs: files({
    '/proc/meminfo': 'MemTotal:  1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\n',
    '/sys/class/thermal/thermal_zone0/temp': '48500\n',
    '/proc/cpuinfo': 'processor : 0\nprocessor : 1\nHardware : Allwinner H3\n',
    '/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq': '480000',
    '/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq': '1008000',
    '/proc/device-tree/model': 'Xunlong Orange Pi One\0',
  }) });
  const snap = s.snapshot();
  assert.deepEqual(snap.ram, { total: 1024000, free: 409600 });
  assert.equal(snap.temp, 48.5);
  assert.deepEqual(snap.cpuinfo, { length: 2, speed: { min: 480, max: 1008 } });
  assert.equal(snap.system.model, 'Xunlong Orange Pi One');
  assert.equal(snap.system.system, 'Allwinner H3');
});

test('storage from statfs; a failing statfs gives zeros', () => {
  const ok = createStats({ fs: files({}), statfs: () => ({ blocks: 100, bsize: 10, bavail: 25 }) });
  assert.deepEqual(ok.snapshot().storage.root, { size: 1000, used: 750 });
  const bad = createStats({ fs: files({}), statfs: () => { throw new Error('x'); } });
  assert.deepEqual(bad.snapshot().storage.user, { size: 0, used: 0 });
});

test('nothing readable: every field is empty, nothing throws', () => {
  const s = createStats({ fs: files({}), statfs: () => { throw new Error('x'); }, runCommand: () => { throw new Error('no ip'); } });
  const snap = s.snapshot();
  assert.deepEqual(snap.cpuusage, []);
  assert.equal(snap.interfaceInfo, '[]');
  assert.equal(snap.temp, 0);
});

test('interfaceInfo is the raw string from ip, for the page to JSON.parse', () => {
  let argv;
  const s = createStats({ fs: files({}), runCommand: (a) => { argv = a; return '[{"ifname":"eth0"}]'; } });
  assert.equal(s.snapshot().interfaceInfo, '[{"ifname":"eth0"}]');
  assert.deepEqual(argv, ['ip', '-s', '-j', 'link', 'show']);
});

test('systemInfo mirrors ubus: uptime and local time in seconds, load scaled by 65536, memory in bytes', () => {
  const s = createStats({ fs: files({ '/proc/uptime': '123.45 99.0\n', '/proc/loadavg': '0.50 0.25 0.10 1/100 999\n', '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n' }) });
  const i = s.systemInfo();
  assert.equal(i.uptime, 123);
  assert.deepEqual(i.load, [32768, 16384, 6554]);
  assert.deepEqual(i.memory, { total: 1024000, free: 409600 });
  assert.ok(Math.abs(i.localtime - Date.now() / 1000) < 5);
  assert.deepEqual(createStats({ fs: files({}) }).systemInfo().load, []);
});
```

Create `test/passthrough.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createPassthrough } = require('../lib/wire/passthrough');

const make = (out = '{"uptime":5,"a":1}') => {
  const calls = [];
  let rebooted = 0;
  const run = createPassthrough({ runCommand: (a) => { calls.push(a); return out; }, reboot: () => { rebooted++; }, systemInfo: () => ({ uptime: 7 }) });
  return { run, calls, rebooted: () => rebooted };
};

test('allowed lines run a fixed argv and answer the parsed JSON', () => {
  const t = make();
  assert.deepEqual(t.run('ubus call system info'), { uptime: 5, a: 1 });
  assert.deepEqual(t.run('ubus call network.interface.wan status'), { uptime: 5, a: 1 });
  assert.deepEqual(t.calls, [['ubus', 'call', 'system', 'info'], ['ubus', 'call', 'network.interface.wan', 'status']]);
});

test('anything else is refused without running a thing, including injection attempts', () => {
  const t = make();
  for (const bad of ['rm -rf /', 'ubus call system info; reboot', 'ubus call network.interface.lan status', 'ubus call network.interface.wan status && id', 'ubus call uci set', '', null, undefined, 5, {}, ['ubus']]) {
    assert.deepEqual(t.run(bad), {}, String(bad));
  }
  assert.equal(t.calls.length, 0);
  assert.equal(t.rebooted(), 0);
});

test('reboot answers an empty stdout and triggers the reboot hook once', () => {
  const t = make();
  assert.deepEqual(t.run('ubus call system reboot'), { stdout: '' });
  assert.equal(t.rebooted(), 1);
});

test('failing or non-JSON output is an empty answer, except system info which falls back to /proc figures', () => {
  assert.deepEqual(make('not json').run('network.interface.wan'), {});
  assert.deepEqual(make('not json').run('ubus call network.interface.wan status'), {});
  assert.deepEqual(make('not json').run('ubus call system info'), { uptime: 7 });
  const run = createPassthrough({ runCommand: () => { throw new Error('ubus: not found'); }, reboot() {}, systemInfo: () => ({ uptime: 9 }) });
  assert.deepEqual(run('ubus call system info'), { uptime: 9 });
  assert.deepEqual(run('ubus call network.interface.wan status'), {});
});
```

Create `test/notifications.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNotifications } = require('../lib/store/notifications');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5n-')), 'sub', 'notification.json');

test('add, list, mark read, clear', () => {
  let t = 0;
  const n = createNotifications({ file: file(), now: () => new Date(Date.UTC(2026, 9, 11, 0, 0, t++)) });
  assert.deepEqual(n.list(), {});
  n.add({ title: 'Hello', message: 'first' });
  const [date] = Object.keys(n.list());
  assert.deepEqual(n.list()[date], { title: 'Hello', icon: 'mdi-information-outline', message: 'first', read: false });
  assert.equal(date, String(Date.UTC(2026, 9, 11, 0, 0, 0)), 'the key is epoch milliseconds, which the page parseInt()s into a date');
  assert.equal(n.markRead(date), true);
  assert.equal(n.list()[date].read, true);
  assert.equal(n.markRead('946684800000'), false);
  n.clear();
  assert.deepEqual(n.list(), {});
});

test('keeps only the newest 50', () => {
  let t = 0;
  const n = createNotifications({ file: file(), now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)) });
  for (let i = 0; i < 55; i++) n.add({ title: `n${i}` });
  const all = n.list();
  assert.equal(Object.keys(all).length, 50);
  assert.equal(all[Object.keys(all).sort((a, b) => a - b)[0]].title, 'n5');
});

test('a corrupt or non-object file reads as empty', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (const bad of ['{nope', '[1,2]', 'null', '']) {
    fs.writeFileSync(f, bad);
    assert.deepEqual(createNotifications({ file: f }).list(), {}, bad);
  }
});

test('__proto__ as a date is not marked read', () => {
  const n = createNotifications({ file: file() });
  n.add({ title: 'x' });
  assert.equal(n.markRead('__proto__'), false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/stats.test.js test/passthrough.test.js test/notifications.test.js`
Expected: FAIL, `Cannot find module '../lib/system/stats'`.

- [ ] **Step 3: Write the implementation**

Create `lib/system/stats.js`:

```js
const nodeFs = require('node:fs');

const readText = (fs, file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// Device figures for the dashboard cards. Every reader degrades to an empty value: a missing
// /sys file or a failing `ip` must leave a card blank, never fail the whole dashboard.
function createStats({ fs = nodeFs, runCommand = () => '', statfs = nodeFs.statfsSync, userDir = '/mnt/wifi5' } = {}) {
  let prev = null; // last /proc/stat sample, for the delta

  function cpuTimes() {
    return readText(fs, '/proc/stat')
      .split('\n')
      .filter((l) => /^cpu\d* /.test(l))
      .map((l) => l.trim().split(/\s+/).slice(1).map(Number));
  }

  // One percentage per core, then the overall figure last (the page labels the last bar "ALL").
  function cpuusage() {
    const now = cpuTimes();
    const before = prev || now;
    prev = now;
    const per = now.map((cur, i) => {
      const old = before[i] || cur;
      const total = cur.reduce((a, b) => a + b, 0) - old.reduce((a, b) => a + b, 0);
      const idle = cur[3] + (cur[4] || 0) - (old[3] + (old[4] || 0));
      return total > 0 ? Math.round(((total - idle) / total) * 100) : 0;
    });
    return per.length > 1 ? [...per.slice(1), per[0]] : per; // /proc/stat lists the overall line first
  }

  function cpuinfo() {
    const cores = readText(fs, '/proc/cpuinfo').split('\n').filter((l) => /^processor\s*:/.test(l)).length;
    const khz = (f) => Number(readText(fs, `/sys/devices/system/cpu/cpu0/cpufreq/${f}`)) || 0;
    return { length: cores, speed: { min: khz('cpuinfo_min_freq') / 1000, max: khz('cpuinfo_max_freq') / 1000 } };
  }

  function ram() {
    const kb = (key) => Number((new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(readText(fs, '/proc/meminfo')) || [])[1]) * 1024 || 0;
    return { total: kb('MemTotal'), free: kb('MemAvailable') || kb('MemFree') };
  }

  function disk(dir) {
    try {
      const s = statfs(dir);
      const size = s.blocks * s.bsize;
      return { size, used: size - s.bavail * s.bsize };
    } catch {
      return { size: 0, used: 0 };
    }
  }

  const temp = () => (Number(readText(fs, '/sys/class/thermal/thermal_zone0/temp')) || 0) / 1000;

  function system() {
    const model = readText(fs, '/proc/device-tree/model').replace(/\0/g, '').trim();
    const chip = (/^(?:Hardware|model name)\s*:\s*(.+)$/m.exec(readText(fs, '/proc/cpuinfo')) || [])[1] || '';
    return { model, system: chip.trim(), release: { target: process.arch } };
  }

  // `ip -s -j link show` as the string the page JSON.parses itself.
  function interfaceInfo() {
    try {
      return runCommand(['ip', '-s', '-j', 'link', 'show']) || '[]';
    } catch {
      return '[]';
    }
  }

  // What `ubus call system info` answers on OpenWrt, from /proc, for a host without ubus (a dev machine, CI).
  function systemInfo() {
    const up = Number(readText(fs, '/proc/uptime').split(' ')[0]) || 0;
    const load = readText(fs, '/proc/loadavg').split(' ').filter(Boolean).slice(0, 3).map((n) => Math.round(Number(n) * 65536) || 0);
    const { total, free } = ram();
    return { uptime: Math.round(up), localtime: Math.round(Date.now() / 1000), load, memory: { total, free } };
  }

  return {
    systemInfo,
    snapshot: () => ({ cpuusage: cpuusage(), cpuinfo: cpuinfo(), ram: ram(), storage: { root: disk('/'), user: disk(userDir) }, temp: temp(), system: system(), interfaceInfo: interfaceInfo() }),
  };
}

module.exports = { createStats };
```

Create `lib/wire/passthrough.js`:

```js
// @nav-23441: the dashboard asks for read-only device facts as a command line. The original ran any
// line matching its regex allowlist; here each allowed line maps to a fixed argv and nothing else runs.
const IFACE = /^ubus call network\.interface\.(wan|wan2|wg0) status$/;

function createPassthrough({ runCommand, reboot, systemInfo }) {
  const parse = (out) => {
    try {
      return JSON.parse(out);
    } catch {
      return {};
    }
  };
  return function run(line) {
    if (typeof line !== 'string') return {};
    try {
      if (line === 'ubus call system info') {
        const out = parse(runCommand(['ubus', 'call', 'system', 'info']));
        return out.uptime === undefined ? systemInfo() : out;
      }
      const m = IFACE.exec(line);
      if (m) return parse(runCommand(['ubus', 'call', `network.interface.${m[1]}`, 'status']));
      if (line === 'ubus call system reboot') {
        reboot(); // the page treats stdout === '' as "Restarting"
        return { stdout: '' };
      }
    } catch {
      // No ubus (not OpenWrt): the interface cards stay absent, but the uptime still has an answer.
      if (line === 'ubus call system info') return systemInfo();
    }
    return {};
  };
}

module.exports = { createPassthrough };
```

Create `lib/store/notifications.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

const MAX = 50;

// Bell-menu notices, {<epoch ms>: {title, icon, message, read}} in one JSON file; the page parses the key
// with parseInt() for the date and reads `message` for the body. Oldest are dropped past MAX.
function createNotifications({ file, now = () => new Date() }) {
  function load() {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  function save(all) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, file);
  }
  return {
    list: load,
    add({ title, icon = 'mdi-information-outline', message = '' }) {
      const all = load();
      all[String(now().getTime())] = { title: String(title), icon, message: String(message), read: false };
      const keys = Object.keys(all).sort((a, b) => Number(a) - Number(b));
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
      save(all);
    },
    markRead(date) {
      const all = load();
      if (!Object.hasOwn(all, date)) return false;
      all[date].read = true;
      save(all);
      return true;
    },
    clear: () => save({}),
  };
}

module.exports = { createNotifications };
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test test/stats.test.js test/passthrough.test.js test/notifications.test.js`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/system/stats.js lib/wire/passthrough.js lib/store/notifications.js test/stats.test.js test/passthrough.test.js test/notifications.test.js
git commit -m "feat: device stats, read-only command passthrough, notifications store

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 9: Session extend, start time, and the ARP neighbour table

**Files:**
- Modify: `lib/session.js`, `lib/arp.js`
- Create: `test/session-extend.test.js`

**Interfaces:**
- Produces: `session.extend(mac, ms, now)` returns the session or `null` (only a live session, only a finite `ms > 0`); new sessions carry `startedAt`; `arp.neighbors()` returns `{ "<lower-case mac>": { ip, dev } }` and never throws. Review Focus 4 is pinned here.

- [ ] **Step 1: Write the failing tests**

Create `test/session-extend.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createSessionStore } = require('../lib/session');
const { createArp } = require('../lib/arp');

const store = () => { const s = createSessionStore('/nonexistent/s.json'); s.load(); return s; };

test('addCredit records startedAt on a new session only', () => {
  const s = store();
  s.addCredit('m1', 1, 1, 1000);
  s.addCredit('m1', 1, 1, 5000);
  assert.equal(s.getSession('m1').startedAt, 1000);
});

test('extend adds time without adding credit, only to a live session', () => {
  const s = store();
  s.addCredit('m1', 1, 1, 1000); // expires 61000
  assert.equal(s.extend('m1', 30000, 2000).expiresAt, 91000);
  assert.equal(s.getSession('m1').creditPesos, 1);
  assert.equal(s.extend('nobody', 30000, 2000), null);
  assert.equal(s.extend('m1', 30000, 91000), null, 'expired');
  for (const bad of [0, -5, NaN, undefined, '60000']) assert.equal(s.extend('m1', bad, 2000), null, String(bad));
  assert.equal(s.getSession('m1').expiresAt, 91000);
});

test('arp.neighbors maps lower-cased mac to ip and device; garbage lines and failures are ignored', () => {
  const out = '10.0.0.5 dev br-lan lladdr AA:BB:CC:DD:EE:FF REACHABLE\n10.0.0.6 dev br-lan  FAILED\nfe80::1 dev eth0 lladdr 11:22:33:44:55:66 router STALE\nnoise\n';
  assert.deepEqual(createArp(() => out).neighbors(), {
    'aa:bb:cc:dd:ee:ff': { ip: '10.0.0.5', dev: 'br-lan' },
    '11:22:33:44:55:66': { ip: 'fe80::1', dev: 'eth0' },
  });
  assert.deepEqual(createArp(() => { throw new Error('x'); }).neighbors(), {});
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/session-extend.test.js`
Expected: FAIL (`s.extend is not a function`, `startedAt` undefined, `neighbors is not a function`).

- [ ] **Step 3: Replace the two files with these versions**

They differ from the current files only by: the `startedAt` field, `extend`, and `neighbors`. Replace `lib/session.js`:

```js
const fs = require('node:fs');

function createSessionStore(filePath) {
  let sessions = {}; // mac -> { mac, creditPesos, expiresAt, startedAt }

  function load(now = Date.now()) {
    sessions = {};
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // missing file: start empty, not an error
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt file: start empty, not an error
    }
    for (const [mac, sess] of Object.entries(parsed)) {
      if (sess.expiresAt > now) sessions[mac] = sess;
    }
  }

  function save() {
    fs.mkdirSync(require('node:path').dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessions));
    fs.renameSync(tmp, filePath); // atomic: a crash leaves the old file or the new one, never a half-write
  }

  function getSession(mac) {
    return sessions[mac];
  }

  function isActive(mac, now = Date.now()) {
    const sess = sessions[mac];
    return !!sess && sess.expiresAt > now;
  }

  function addCredit(mac, pesos, ratePesosPerMinute, now = Date.now()) {
    const existing = sessions[mac];
    const minutes = pesos / ratePesosPerMinute;
    if (existing && existing.expiresAt > now) {
      existing.creditPesos += pesos;
      existing.expiresAt += minutes * 60000;
    } else {
      sessions[mac] = { mac, creditPesos: pesos, expiresAt: now + minutes * 60000, startedAt: now };
    }
    return sessions[mac];
  }

  // Admin "extend": more time, no more credit. Only a live session can be extended.
  function extend(mac, ms, now = Date.now()) {
    const sess = sessions[mac];
    if (!sess || sess.expiresAt <= now || !Number.isFinite(ms) || ms <= 0) return null;
    sess.expiresAt += ms;
    return sess;
  }

  function expireDue(now = Date.now()) {
    const due = [];
    for (const [mac, sess] of Object.entries(sessions)) {
      if (sess.expiresAt <= now) due.push(mac);
    }
    for (const mac of due) delete sessions[mac];
    return due;
  }

  function revoke(mac) {
    if (!(mac in sessions)) return false;
    delete sessions[mac];
    return true;
  }

  function all() {
    return { ...sessions };
  }

  return { load, save, addCredit, extend, getSession, isActive, expireDue, revoke, all };
}

module.exports = { createSessionStore };
```

Replace `lib/arp.js`:

```js
function createArp(runCommand) {
  function ipToMac(ip) {
    let out;
    try {
      out = runCommand(['ip', 'neigh', 'show', ip]);
    } catch {
      return null;
    }
    const match = /lladdr\s+([0-9a-f:]{17})/i.exec(out || '');
    return match ? match[1] : null;
  }

  // mac -> { ip, dev } for every neighbour with a link-layer address (the dashboard's address column).
  function neighbors() {
    const out = {};
    let text = '';
    try {
      text = runCommand(['ip', 'neigh', 'show']) || '';
    } catch {
      return out;
    }
    for (const line of text.split('\n')) {
      const m = /^(\S+)\s+dev\s+(\S+)\s+lladdr\s+([0-9a-f:]{17})/i.exec(line);
      if (m) out[m[3].toLowerCase()] = { ip: m[1], dev: m[2] };
    }
    return out;
  }

  return { ipToMac, neighbors };
}

module.exports = { createArp };
```

- [ ] **Step 4: Run them, and the existing session/arp tests, and watch them pass**

Run: `node --test test/session-extend.test.js test/session.test.js test/arp.test.js`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/session.js lib/arp.js test/session-extend.test.js
git commit -m "feat: session extend and start time, ARP neighbour table

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 10: The shell, dashboard, logs and notification handlers

**Files:**
- Create: `lib/wire/nav.js`
- Create: `test/wire-nav.test.js`

**Interfaces:**
- Consumes: Tasks 4, 7, 8, 9 (all passed in by `main.js`; the tests use fakes).
- Produces: `createNavHandlers({sessions, firewall, arp, stats, passthrough, mainlog, notifications, licence, account, reset, now, save})` returns an event table with `guard: true` on every entry: `@nav-89554 @nav-23441 @nav-77833 @nav-232003 @nav-1452357 @nav-14433223 @nav-89000 @nav-22313 @nav-44232 @nav-67345 @nav-645798 @nav-636547 @nav-362358 @nav-365478 @nav-63658987 @nav-3265892 @nav-3654780 @nav-3332145`.

Reply shapes were recorded from the unmodified dashboard in headless Firefox (the `Proxy` recorder found two gaps the decompiled code did not show: `active.data[mac].uploadLimit` / `downloadLimit` must be **strings** (the page calls `toLowerCase()` on them) and each session row needs `rx` / `tx`; without them the page threw half-way through drawing the table and showed "Active Users: 0"). Decisions kept from the spec: Disconnect (`@nav-22313`) answers the original error shape because vendo5 sessions cannot be paused (needs sub-project #7); factory reset (`@nav-3332145`) is scoped to vendo5's own state (sessions, login, notices) and does not restart the process.

- [ ] **Step 1: Write the failing tests**

Create `test/wire-nav.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createNavHandlers } = require('../lib/wire/nav');
const { createSessionStore } = require('../lib/session');

function setup(over = {}) {
  const sessions = createSessionStore('/nonexistent/s.json');
  sessions.load();
  const lines = [];
  const revoked = [];
  const saved = [];
  const state = { cleared: 0, accountReset: 0, notes: { d1: { title: 't', read: false } }, marked: [] };
  const nav = createNavHandlers({
    sessions,
    firewall: { revoke: (m) => { if (over.revokeThrows) throw new Error('not in set'); revoked.push(m); } },
    arp: { neighbors: () => ({ 'aa:bb:cc:dd:ee:01': { ip: '10.0.0.5', dev: 'br-lan' } }) },
    stats: { snapshot: () => ({ cpuusage: [1, 2], temp: 40 }) },
    passthrough: (p) => ({ ran: p }),
    mainlog: { write: (c, t) => lines.push(`${c}|${t}`), list: () => ['system-05-10-2026.txt'], read: (n) => `read ${n}`, remove: (n) => ({ success: true, n }), removeByCategory: (c) => lines.push(`cat|${c}`) },
    notifications: { list: () => state.notes, markRead: (d) => state.marked.push(d), clear: () => { state.cleared++; } },
    licence: { licence: () => ({ serial: 'SER1', hotspot: 1000000, pppoe: 1000000, movie: true, expiration: 8640000000000000 }) },
    account: { reset: () => { state.accountReset++; } },
    now: () => 100000,
    save: () => saved.push(1),
  });
  return { nav, sessions, lines, revoked, saved, state };
}
const call = (nav, id, payload) => nav[id].handler(payload, {});

test('every nav event is guarded', () => {
  const { nav } = setup();
  for (const [id, def] of Object.entries(nav)) assert.equal(def.guard, true, id);
});

test('dashboard: stats plus the active sessions in the shapes the page reads', () => {
  const { nav, sessions } = setup();
  sessions.addCredit('aa:bb:cc:dd:ee:01', 2, 1, 40000); // expires 160000
  sessions.addCredit('aa:bb:cc:dd:ee:02', 1, 1, 90000);
  const r = call(nav, '@nav-89554', { getSessionList: true });
  assert.deepEqual(r.cpuusage, [1, 2]);
  assert.equal(r.now, 100000);
  assert.deepEqual(r.Watching, {});
  assert.deepEqual(r.pppoelist, { accounts: {}, active: {} });
  const d = r.active.data['aa:bb:cc:dd:ee:01'];
  assert.equal(d.expiration, 160000);
  assert.equal(d.logindate, 40000);
  assert.equal(d.duration, 120);
  assert.equal(d.type, 'normal');
  assert.equal(typeof d.uploadLimit, 'string', 'the page calls toLowerCase() on the limits');
  assert.equal(typeof d.downloadLimit, 'string');
  assert.deepEqual(r.active.session['aa:bb:cc:dd:ee:01'], { mac: 'aa:bb:cc:dd:ee:01', address: '10.0.0.5', ifname: 'br-lan', brlan: 'br-lan', uptime: 60, idle: 0, upload: 0, download: 0, rx: 0, tx: 0 });
  assert.equal(r.active.session['aa:bb:cc:dd:ee:02'].address, '', 'a client the ARP table does not know still lists');
  assert.deepEqual(r.active.sessionList, {});
});

test('dashboard with no sessions', () => {
  const r = call(setup().nav, '@nav-89554', undefined);
  assert.deepEqual(r.active, { data: {}, session: {}, sessionList: {} });
});

test('passthrough, name lookup, licence, serial, redeem', () => {
  const { nav } = setup();
  assert.deepEqual(call(nav, '@nav-23441', 'ubus call system info'), { ran: 'ubus call system info' });
  assert.deepEqual(call(nav, '@nav-77833'), { client: { clientInfo: [] } });
  const l = call(nav, '@nav-232003');
  assert.equal(l.status, 'activated');
  assert.equal(l.code, 'SER1');
  assert.equal(l.hotspot, 1000000);
  assert.equal(call(nav, '@nav-1452357'), Buffer.from('SER1').toString('base64'));
  const r = call(nav, '@nav-14433223', { voucher: 'x', email: 'a@b.c', name: 'n' });
  assert.equal(r.success, false);
  assert.match(r.message, /offline/);
});

test('extend adds seconds to a live session and logs; unknown or bad input is Error', () => {
  const { nav, sessions, lines, saved } = setup();
  sessions.addCredit('m1', 1, 1, 50000); // expires 110000
  assert.equal(call(nav, '@nav-89000', { voucher: 'm1', duration: 3600 }), 'Success');
  assert.equal(sessions.getSession('m1').expiresAt, 110000 + 3600000);
  assert.equal(saved.length, 1);
  assert.match(lines[0], /^system\|Admin extended m1 by 3600s$/);
  for (const bad of [{ voucher: 'nobody', duration: 60 }, { voucher: 'm1', duration: 0 }, { voucher: 'm1', duration: 'x' }, { voucher: 'm1' }, null, 'm1', 7]) assert.equal(call(nav, '@nav-89000', bad), 'Error', JSON.stringify(bad));
});

test('remove ends the session and the firewall entry; a firewall that never knew the mac still lets it go', () => {
  const a = setup();
  a.sessions.addCredit('m1', 1, 1, 50000);
  assert.equal(call(a.nav, '@nav-44232', { mac: 'm1' }), 'Success');
  assert.deepEqual(a.revoked, ['m1']);
  assert.equal(a.sessions.getSession('m1'), undefined);
  assert.equal(call(a.nav, '@nav-44232', { mac: 'm1' }), 'Error', 'already gone');
  const b = setup({ revokeThrows: true });
  b.sessions.addCredit('m1', 1, 1, 50000);
  assert.equal(call(b.nav, '@nav-44232', { mac: 'm1' }), 'Success');
  assert.equal(b.sessions.getSession('m1'), undefined);
});

test('bulk remove takes {info:[...]} or a bare array of items or macs', () => {
  const t = setup();
  for (const m of ['m1', 'm2', 'm3']) t.sessions.addCredit(m, 1, 1, 50000);
  assert.equal(call(t.nav, '@nav-67345', { info: [{ mac: 'm1' }] }), 'Success');
  assert.equal(call(t.nav, '@nav-67345', [{ mac: 'm2' }, 'm3', { mac: 'zzz' }]), 'Success');
  assert.deepEqual(Object.keys(t.sessions.all()), []);
  for (const bad of [[], {}, { info: 'm1' }, null, 'm1', 3]) assert.equal(call(t.nav, '@nav-67345', bad), 'Error', JSON.stringify(bad));
});

test('disconnect is unavailable, and says so rather than ending the session', () => {
  const t = setup();
  t.sessions.addCredit('m1', 1, 1, 50000);
  assert.equal(call(t.nav, '@nav-22313', { mac: 'm1' }), 'Error');
  assert.ok(t.sessions.getSession('m1'));
});

test('logs: list, read, delete one, delete a category', () => {
  const t = setup();
  assert.deepEqual(call(t.nav, '@nav-645798'), ['system-05-10-2026.txt']);
  assert.equal(call(t.nav, '@nav-636547', 'system-05-10-2026.txt'), 'read system-05-10-2026.txt');
  assert.deepEqual(call(t.nav, '@nav-362358', 'system-05-10-2026.txt'), { success: true, n: 'system-05-10-2026.txt' });
  assert.deepEqual(call(t.nav, '@nav-365478', 'voucher'), {});
  assert.ok(t.lines.includes('cat|voucher'));
});

test('notifications: list, mark read by date, clear', () => {
  const t = setup();
  assert.deepEqual(call(t.nav, '@nav-63658987'), t.state.notes);
  call(t.nav, '@nav-3265892', { date: 'd1', read: true });
  call(t.nav, '@nav-3265892', null);
  assert.deepEqual(t.state.marked, ['d1', undefined]);
  call(t.nav, '@nav-3654780');
  assert.equal(t.state.cleared, 1);
});

test('factory reset ends all sessions, restores the default login, clears notices, and logs it', () => {
  const t = setup({ revokeThrows: true });
  t.sessions.addCredit('m1', 1, 1, 50000);
  t.sessions.addCredit('m2', 1, 1, 50000);
  assert.equal(call(t.nav, '@nav-3332145'), 'Success');
  assert.deepEqual(t.sessions.all(), {});
  assert.equal(t.state.accountReset, 1);
  assert.equal(t.state.cleared, 1);
  assert.ok(t.lines.some((l) => /reset the device/.test(l)));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/wire-nav.test.js`
Expected: FAIL, `Cannot find module '../lib/wire/nav'`.

- [ ] **Step 3: Write the implementation**

Create `lib/wire/nav.js`:

```js
const crypto = require('node:crypto');

const asObj = (v) => (v && typeof v === 'object' ? v : {});
const macOf = (item) => (typeof item === 'string' ? item : asObj(item).mac);

// Handlers for the admin shell, dashboard and logs pages (@nav-*). Each is (payload, ctx) => reply and
// every one is guarded: no logged-in session, no answer. Replies copy the shapes the original page reads.
function createNavHandlers({ sessions, firewall, arp, stats, passthrough, mainlog, notifications, licence, account, reset, now = Date.now, save = () => {} }) {
  const log = (text) => mainlog.write('system', text);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });

  // Active sessions in the three shapes @nav-89554 carries: data (per mac), session (per mac), pppoe (empty).
  function activeSessions() {
    const t = now();
    const neigh = arp.neighbors();
    const data = {};
    const session = {};
    for (const [mac, s] of Object.entries(sessions.all())) {
      const n = neigh[mac.toLowerCase()] || {};
      data[mac] = {
        type: 'normal',
        duration: Math.round((s.expiresAt - (s.startedAt || t)) / 1000),
        logindate: s.startedAt || t,
        expiration: s.expiresAt,
        uploadLimit: 'Unlimited', // the page parses these as "<n><unit>" strings and tolerates any text
        downloadLimit: 'Unlimited',
        max_data_limit: 0,
        total_upload_data: 0,
        total_download_data: 0,
      };
      session[mac] = { mac, address: n.ip || '', ifname: n.dev || '', brlan: n.dev || '', uptime: Math.max(0, Math.round((t - (s.startedAt || t)) / 1000)), idle: 0, upload: 0, download: 0, rx: 0, tx: 0 };
    }
    return { data, session, sessionList: {} };
  }

  // Removing a session: the firewall may never have heard of it (revoke then throws); the session goes either way.
  function remove(mac) {
    if (typeof mac !== 'string' || !mac) return false;
    try {
      firewall.revoke(mac);
    } catch {
      /* not in the allowed set: nothing to take away */
    }
    const had = sessions.revoke(mac);
    if (had) save();
    return had;
  }

  return {
    '@nav-89554': guarded({}, () => ({ ...stats.snapshot(), Watching: {}, now: now(), active: activeSessions(), pppoelist: { accounts: {}, active: {} } })),

    '@nav-23441': guarded({}, (payload) => passthrough(payload)),

    // The client-name lookup the dashboard uses for its "name" column; vendo5 keeps no client names.
    '@nav-77833': guarded({}, () => ({ client: { clientInfo: [] } })),

    '@nav-232003': guarded({}, () => {
      const l = licence.licence();
      return { status: 'activated', code: l.serial, level: 'Unlimited', hotspot: l.hotspot, pppoe: l.pppoe, vendo: 'Yes', eload: 'Yes', movie: l.movie ? 'Yes' : 'No', serial: l.serial, expiration: l.expiration };
    }),
    '@nav-1452357': guarded('', () => Buffer.from(licence.licence().serial).toString('base64')),
    '@nav-14433223': guarded({}, () => ({ success: false, message: 'This device runs offline: no activation is needed' })),

    // Session actions. Every client row sends back the item it was drawn from ({mac, ...}).
    '@nav-89000': guarded('Error', (payload) => {
      const p = asObj(payload);
      const sess = sessions.extend(p.voucher, Number(p.duration) * 1000, now());
      if (!sess) return 'Error';
      save();
      log(`Admin extended ${p.voucher} by ${p.duration}s`);
      return 'Success';
    }),
    // vendo5 sessions cannot be paused, so there is nothing to disconnect without ending them.
    '@nav-22313': guarded('Error', () => 'Error'),
    '@nav-44232': guarded('Error', (payload) => {
      const mac = macOf(payload);
      if (!remove(mac)) return 'Error';
      log(`Admin removed session ${mac}`);
      return 'Success';
    }),
    '@nav-67345': guarded('Error', (payload) => {
      const list = Array.isArray(payload) ? payload : asObj(payload).info;
      if (!Array.isArray(list) || !list.length) return 'Error';
      let n = 0;
      for (const item of list) if (remove(macOf(item))) n++;
      if (n) log(`Admin removed ${n} session(s)`);
      return n ? 'Success' : 'Error';
    }),

    // Logs page.
    '@nav-645798': guarded([], () => mainlog.list()),
    '@nav-636547': guarded('', (name) => mainlog.read(name)),
    '@nav-362358': guarded({ success: false }, (name) => mainlog.remove(name)),
    '@nav-365478': guarded({}, (category) => {
      mainlog.removeByCategory(category);
      return {};
    }),

    // Notification bell.
    '@nav-63658987': guarded({}, () => notifications.list()),
    '@nav-3265892': guarded({}, (payload) => {
      notifications.markRead(asObj(payload).date);
      return {};
    }),
    '@nav-3654780': guarded({}, () => {
      notifications.clear();
      return {};
    }),

    // "Factory reset" in the profile menu: ends every session, restores the default login, clears notices.
    '@nav-3332145': guarded('Error', () => {
      for (const mac of Object.keys(sessions.all())) remove(mac);
      account.reset();
      notifications.clear();
      if (reset) reset();
      log('Admin reset the device');
      return 'Success';
    }),
  };
}

module.exports = { createNavHandlers };
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test test/wire-nav.test.js`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/wire/nav.js test/wire-nav.test.js
git commit -m "feat: shell, dashboard, logs and notification event handlers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 11: Wire everything into the server and remove the old admin

**Files:**
- Create: `test/admin-e2e.test.js`
- Modify: `lib/portal.js`, `main.js`, `lib/config.js`, `test/portal.test.js`, `test/main.test.js`, `test/config.test.js`
- Delete: `lib/admin.js`, `test/admin.test.js`, `config/admin.json`

**Interfaces:**
- Consumes: everything above.
- Produces: `createServer({session, arp, ratePesosPerMinute, adminRoutes})` (`adminRoutes` optional: absent means `/admin` is not served and the portal page answers); `main.js` reads `VENDO5_UI_DIR` (default `/opt/vendo5/ui`) and `VENDO5_STATE_DIR` (default `/mnt/wifi5/vendo5`). Admin setup failing (state dir not writable, UI files missing) is logged as `admin page unavailable` and the portal keeps running. Review Focus 2 and 5 are pinned here.

- [ ] **Step 1: Write the failing end-to-end test**

It boots the real `main.js` as a process, logs in like a browser, reads the dashboard, removes a session, reads the log, inserts a coin through a fake GPIO pin and finds it in the log, and checks the failure modes. Create `test/admin-e2e.test.js`:

```js
// The real main.js, booted as a process: factory login, dashboard data, a session action, the log it wrote.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { io: connect } = require('socket.io-client');

const MAIN = path.join(__dirname, '..', 'main.js');
const UI = require('./helpers/ui-root');
const MAC = 'aa:bb:cc:dd:ee:01';
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(UI, 'main', 'js', 'md5.js'), 'utf8'), sandbox);

const waitFor = async (get, re) => { for (let i = 0; i < 160 && !re.test(get()); i++) await new Promise((x) => setTimeout(x, 50)); };
const req = (port, method, p, { cookie, body, type } = {}) => new Promise((resolve, reject) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = type;
  const q = http.request({ port, method, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  q.on('error', reject);
  q.end(body);
});
const ask = (c, id, payload) => new Promise((resolve) => (payload === undefined ? c.emit(id, resolve) : c.emit(id, payload, resolve)));

async function boot(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5e2e-'));
  const stateDir = path.join(root, 'state');
  const sessionFile = path.join(root, 'sessions.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ [MAC]: { mac: MAC, creditPesos: 2, expiresAt: Date.now() + 600000, startedAt: Date.now() - 60000 } }));
  const gpio = path.join(root, 'gpio');
  fs.mkdirSync(path.join(gpio, 'gpio17'), { recursive: true });
  for (const f of ['export', 'unexport', 'gpio17/value', 'gpio17/direction', 'gpio17/edge']) fs.writeFileSync(path.join(gpio, f), '0');
  const p = spawn(process.execPath, [MAIN], { env: { ...process.env, VENDO5_CONFIG_DIR: path.join(root, 'cfg'), VENDO5_DEFAULTS_DIR: path.join(__dirname, '..', 'config'), VENDO5_SESSION_FILE: sessionFile, VENDO5_STATE_DIR: stateDir, VENDO5_UI_DIR: UI, VENDO5_GPIO_BASE: gpio, VENDO5_PORTAL_PORT: '0', VENDO5_FIREWALL_CMD: 'noop', ...extraEnv } });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  const stop = () => p.kill('SIGKILL');
  await waitFor(() => out, /portal listening/);
  const line = /^.*"portal listening".*$/m.exec(out);
  if (!line) { stop(); throw new Error('server did not start:\n' + out); }
  return { port: JSON.parse(line[0]).port, stateDir, sessionFile, gpio, out: () => out, stop };
}

async function login(port, user, pass) {
  const cookie = (await req(port, 'GET', '/admin')).headers['set-cookie'][0].split(';')[0];
  const sock = await new Promise((resolve, reject) => {
    const c = connect('http://127.0.0.1:' + port, { path: '/admin', reconnection: false, extraHeaders: { cookie } });
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
  const token = await ask(sock, '@main-48931');
  const h = (token.length - 1) / 2;
  const reply = await ask(sock, '@main-66589', {
    uname: user,
    username: sandbox.hexMD5(token.substring(0, h) + user.toLowerCase()),
    password: sandbox.hexMD5(token.substring(h, token.length) + pass),
  });
  return { sock, cookie, reply };
}

test('factory login works, the dashboard lists the paid session, remove ends it, the log records it', async () => {
  const s = await boot();
  try {
    assert.match(s.out(), /factory default/);
    const { sock, cookie, reply } = await login(s.port, 'admin', 'admin');
    assert.deepEqual(reply, { login: true });
    assert.equal((await req(s.port, 'POST', '/admin', { cookie, body: '', type: 'application/x-www-form-urlencoded' })).headers.location, '/admin?page=dashboard');
    const dash = await ask(sock, '@nav-89554', { getSessionList: true });
    assert.deepEqual(Object.keys(dash.active.session), [MAC]);
    assert.ok(dash.active.data[MAC].expiration > Date.now());
    assert.equal(await ask(sock, '@nav-44232', { mac: MAC }), 'Success');
    assert.deepEqual(Object.keys((await ask(sock, '@nav-89554', {})).active.session), []);
    await waitFor(() => (fs.existsSync(s.sessionFile) ? fs.readFileSync(s.sessionFile, 'utf8') : '{"x":1}'), /^\{\}$/);
    assert.equal(fs.readFileSync(s.sessionFile, 'utf8'), '{}', 'the removal is persisted');
    const files = await ask(sock, '@nav-645798');
    assert.equal(files.length, 1);
    const text = await ask(sock, '@nav-636547', files[0]);
    assert.match(text, /Admin Success Login: user admin from/);
    assert.match(text, new RegExp(`Admin removed session ${MAC}`));
    sock.close();
  } finally { s.stop(); }
});

test('the wrong password never opens the admin events', async () => {
  const s = await boot();
  try {
    const { sock, reply } = await login(s.port, 'admin', 'nope');
    assert.deepEqual(reply, { login: false });
    const gone = new Promise((r) => sock.on('disconnect', r));
    sock.emit('@nav-89554', {}, () => assert.fail('answered an unauthenticated dashboard request'));
    await gone;
  } finally { s.stop(); }
});

test('the captive portal still answers every other path', async () => {
  const s = await boot();
  try {
    const home = await req(s.port, 'GET', '/generate_204');
    assert.equal(home.status, 200);
    assert.match(home.body, /client-insert-coin/);
    assert.equal((await req(s.port, 'GET', '/main/js/md5.js')).status, 200);
    assert.equal((await req(s.port, 'GET', '/admin/')).headers.location, '/admin?page=dashboard');
  } finally { s.stop(); }
});

test('an unusable state dir or missing UI files leave the captive portal running without /admin', async () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5blk-')), 'file');
  fs.writeFileSync(blocker, 'x');
  const s = await boot({ VENDO5_STATE_DIR: path.join(blocker, 'state') });
  try {
    assert.match(s.out(), /admin page unavailable/);
    const r = await req(s.port, 'GET', '/admin');
    assert.equal(r.status, 200);
    assert.match(r.body, /client-insert-coin/, '/admin falls through to the portal page');
  } finally { s.stop(); }
});

test('the dashboard works with the fixed-MAC test ARP too (it has no neighbour table)', async () => {
  const s = await boot({ VENDO5_ARP_FAKE_MAC: 'aa:bb:cc:dd:ee:99' });
  try {
    const { sock } = await login(s.port, 'admin', 'admin');
    const dash = await ask(sock, '@nav-89554', {});
    assert.deepEqual(Object.keys(dash.active.session), [MAC]);
    assert.ok(!/"level":"error"/.test(s.out()), s.out());
    sock.close();
  } finally { s.stop(); }
});

test('every enabled page is served to a logged-in admin, and a disabled one bounces to the dashboard', async () => {
  const s = await boot();
  try {
    const { sock, cookie } = await login(s.port, 'admin', 'admin');
    await req(s.port, 'POST', '/admin', { cookie, body: '', type: 'application/x-www-form-urlencoded' });
    for (const page of ['dashboard', 'logs']) {
      const r = await req(s.port, 'GET', `/admin?page=${page}`, { cookie });
      assert.equal(r.status, 200, page);
      assert.ok(r.body.includes(`script/${page}.js`), page);
    }
    const hidden = await req(s.port, 'GET', '/admin?page=chat', { cookie });
    assert.equal(hidden.status, 302);
    assert.equal(hidden.headers.location, '/admin?page=dashboard');
    sock.close();
  } finally { s.stop(); }
});

test('a coin is written to the system log the admin reads', async () => {
  const s = await boot({ VENDO5_ARP_FAKE_MAC: 'aa:bb:cc:dd:ee:77' });
  try {
    assert.equal((await req(s.port, 'POST', '/api/pay-intent', { body: '{}', type: 'application/json' })).status, 200);
    fs.writeFileSync(path.join(s.gpio, 'gpio17', 'value'), '1');
    await waitFor(() => s.out(), /firewall allow/);
    const { sock } = await login(s.port, 'admin', 'admin');
    const files = await ask(sock, '@nav-645798');
    const text = await ask(sock, '@nav-636547', files[0]);
    assert.match(text, /Coin: 1 peso\(s\) credited to aa:bb:cc:dd:ee:77/);
    sock.close();
  } finally { s.stop(); }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/admin-e2e.test.js`
Expected: FAIL (the old `main.js` has no `/admin` socket; the boot helper times out or the login never answers).

- [ ] **Step 3: Replace `lib/portal.js`**

The old admin page, its `/admin/login`, `/admin/logout`, `/admin/api/*` routes, `parseCookies`, `readJsonBody`, `escapeHtml` and the `firewall` / `adminAuth` parameters are gone; admin routes are tried after `/theme/` and **before** `clientMac(req)` (which shells out to `ip neigh`, once per request, and the admin frontend makes hundreds of requests):

```js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PAY_INTENT_TTL_MS = 10000;
const THEME_DIR = path.join(__dirname, '..', 'public', 'theme');
const THEME_TYPES = { '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };

function shell(title, body, script = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/theme/favicon.png">
<link rel="stylesheet" href="/theme/vendo.css">
</head>
<body>
${body}
<script>
var toastada = { info: toast, success: toast, warning: toast, error: toast };
function toast(msg) {
  var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3000);
}
function post(url, data) {
  // final-review fix: a 401/404/500 response has an empty body; the old
  // r.json() threw on it (unhandled rejection) for every caller. Read as
  // text and parse defensively so callers always get an object back.
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }).then(function (r) {
    return r.text().then(function (t) {
      var parsed = {}; try { parsed = t ? JSON.parse(t) : {}; } catch (e) {}
      return parsed;
    });
  });
}
${script}
</script>
</body>
</html>`;
}

function clientPage() {
  return shell('MekusMekus WiFi', `<div class="wrap">
<img class="banner" src="/theme/banner.jpg" alt="MekusMekus Labs">
<div class="card">
<h2 id="title-status">Offline</h2>
<div class="big" id="client-duration">00:00</div>
<div class="state" id="client-credit">Insert coin to continue</div>
</div>
<div class="card"><button id="client-insert-coin">INSERT COIN</button></div>
<div class="tag">They Invent. We Reinvent.</div>
</div>`, `
document.getElementById('client-insert-coin').onclick = function () {
  post('/api/pay-intent').then(function () { toastada.info('Insert your coin now.'); });
};
function poll() {
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    var m = Math.floor(s.remainingSeconds / 60), sec = s.remainingSeconds % 60;
    document.getElementById('title-status').textContent = s.active ? 'Online' : 'Offline';
    document.getElementById('title-status').className = s.active ? 'on' : '';
    document.getElementById('client-duration').textContent = s.active ? m + 'm ' + sec + 's' : '00:00';
    document.getElementById('client-credit').textContent = s.active ? 'Connected' : 'Insert coin to continue';
  });
}
poll(); setInterval(poll, 2000);`);
}

function serveThemeFile(urlPath, res) {
  const rel = urlPath.replace(/^\/theme\//, '');
  const ext = path.extname(rel);
  const filePath = path.join(THEME_DIR, rel);
  // shortcut: no path-traversal check beyond extname allow-list; theme/
  // only ever serves our own static assets, no user input reaches rel.
  if (!THEME_TYPES[ext] || !filePath.startsWith(THEME_DIR)) { res.writeHead(404).end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': THEME_TYPES[ext] });
    res.end(data);
  });
}

function createServer({ session, arp, ratePesosPerMinute, adminRoutes }) {
  let pendingPayer = null; // { mac, at }

  // Ruling (code-review fix pass): don't clear on a successful consume —
  // touch (refresh) the window instead, so back-to-back coin pulses for
  // the same payer (plan's own Review Focus #1) keep finding them. Only
  // an actual TTL lapse with no intervening pulse frees the slot.
  function consumePendingPayer(now = Date.now()) {
    if (!pendingPayer) return null;
    const { mac, at } = pendingPayer;
    if (now - at > PAY_INTENT_TTL_MS) {
      pendingPayer = null;
      return null;
    }
    pendingPayer = { mac, at: now };
    return mac;
  }

  // A different MAC may not steal an already-active pending-payer slot;
  // the same MAC always refreshes its own window.
  function setPendingPayer(mac, now = Date.now()) {
    if (pendingPayer && pendingPayer.mac !== mac && now - pendingPayer.at <= PAY_INTENT_TTL_MS) {
      return false;
    }
    pendingPayer = { mac, at: now };
    return true;
  }

  function clientMac(req) {
    // dual-stack server binds to '::' by default; real IPv4 clients arrive
    // as '::ffff:a.b.c.d' and `ip neigh show` has no entry for that form.
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return arp.ipToMac(ip);
  }

  function remainingSecondsFor(mac, now = Date.now()) {
    const sess = session.getSession(mac);
    if (!sess) return 0;
    return Math.max(0, Math.round((sess.expiresAt - now) / 1000));
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/theme/')) {
      serveThemeFile(req.url, res);
      return;
    }

    // /admin and the admin frontend's static files; before clientMac(), which shells out to `ip neigh`.
    if (adminRoutes && adminRoutes(req, res)) return;

    const mac = clientMac(req);

    if (req.method === 'POST' && req.url === '/api/pay-intent') {
      const ok = mac ? setPendingPayer(mac) : false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      const active = !!mac && session.isActive(mac);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active, remainingSeconds: active ? remainingSecondsFor(mac) : 0 }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(clientPage());
  });

  return { server, consumePendingPayer };
}

module.exports = { createServer };
```

- [ ] **Step 4: Replace `main.js`**

New: the admin wiring in a `try` (a failure must not take the captive portal down), `VENDO5_UI_DIR` / `VENDO5_STATE_DIR`, a 5-second timeout on every external command, the fixed-MAC test ARP gets a `neighbors()`, and coins are written to the system log:

```js
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('./lib/config');
const { log } = require('./lib/logger');
const { createGpio } = require('./lib/gpio');
const { createSessionStore } = require('./lib/session');
const { createFirewall } = require('./lib/firewall');
const { createArp } = require('./lib/arp');
const { createServer } = require('./lib/portal');
const { createStatic } = require('./lib/ui/static');
const { createPages } = require('./lib/ui/pages');
const { createAdminRoutes } = require('./lib/ui/admin-routes');
const { createAccountStore } = require('./lib/store/account');
const { createNotifications } = require('./lib/store/notifications');
const { createLicence } = require('./lib/licence');
const { createMainLog } = require('./lib/system/mainlog');
const { createStats } = require('./lib/system/stats');
const { createSessions } = require('./lib/wire/session');
const { createMainHandlers } = require('./lib/wire/main');
const { createNavHandlers } = require('./lib/wire/nav');
const { createPassthrough } = require('./lib/wire/passthrough');
const { attachWire } = require('./lib/wire/server');
const { version } = require('./package.json');

const configDir = process.env.VENDO5_CONFIG_DIR || '/mnt/wifi5/vendo5-config';
const defaultsDir = process.env.VENDO5_DEFAULTS_DIR || '/opt/vendo5/config';
const sessionFile = process.env.VENDO5_SESSION_FILE || '/mnt/wifi5/vendo5-sessions.json';
const gpioBase = process.env.VENDO5_GPIO_BASE || '/sys/class/gpio';
const uiDir = process.env.VENDO5_UI_DIR || '/opt/vendo5/ui';
const stateDir = process.env.VENDO5_STATE_DIR || '/mnt/wifi5/vendo5';
const portalPort = Number(process.env.VENDO5_PORTAL_PORT || 3000);

let config;
try {
  config = loadConfig(configDir, defaultsDir);
} catch (e) {
  log('error', e.message);
  process.exit(1);
}

const shutdown = () => { log('info', 'vendo5 stopping'); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

log('info', 'vendo5 started', { version, config: Object.keys(config) });

const { coin_pin, pulse_value_pesos, pesos_per_minute } = config.vendo;

const session = createSessionStore(sessionFile);
session.load();

// shortcut: no-op shell-out for firewall/arp when VENDO5_FIREWALL_CMD=noop
// (used by the smoke test, which has no real nft/ip environment). Real
// deployments never set this, so production always shells out for real.
const runCommand = process.env.VENDO5_FIREWALL_CMD === 'noop'
  ? () => ''
  : (args) => {
      const { execFileSync } = require('node:child_process');
      return execFileSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 5000 }); // a hung command must not freeze the event loop for long
    };

const firewall = createFirewall(runCommand);
// shortcut: VENDO5_ARP_FAKE_MAC fixes every client's resolved MAC, for
// tests that need a deterministic payer without a real LAN/ARP table.
// Real deployments never set this.
const arp = process.env.VENDO5_ARP_FAKE_MAC
  ? { ipToMac: () => process.env.VENDO5_ARP_FAKE_MAC, neighbors: () => ({}) }
  : createArp(runCommand);

try {
  firewall.syncFromSessions(session.all());
} catch (e) {
  log('error', 'firewall sync failed at boot', { error: e.message });
}

// The admin page needs a writable state dir and the UI files. Without them the captive portal must
// still sell time, so a failure here is logged and /admin simply is not served.
let admin = null;
try {
  const account = createAccountStore(path.join(stateDir, 'account.json'));
  if (account.load()) log('warn', 'admin login created with the factory default; change it from the admin page');
  const licence = createLicence({ stateDir });
  const mainlog = createMainLog({ dir: path.join(stateDir, 'mainlogs') });
  const sessions = createSessions({});
  const pages = createPages({ root: uiDir, version, hostname: os.hostname() });
  const routes = createAdminRoutes({ pages, sessions, serveStatic: createStatic({ root: uiDir }) });
  const stats = createStats({ runCommand });
  const events = {
    ...createMainHandlers({ account, sessions, licence, mainlog, version }),
    ...createNavHandlers({
      sessions: session,
      firewall,
      arp,
      stats,
      passthrough: createPassthrough({ runCommand, reboot: () => runCommand(['reboot']), systemInfo: stats.systemInfo }),
      mainlog,
      notifications: createNotifications({ file: path.join(stateDir, 'notification.json') }),
      licence,
      account,
      save: () => session.save(),
    }),
  };
  admin = { routes, events, sessions, mainlog };
} catch (e) {
  log('error', 'admin page unavailable; the portal runs without it', { error: e.message });
}

const { server, consumePendingPayer } = createServer({ session, arp, ratePesosPerMinute: pesos_per_minute, adminRoutes: admin && admin.routes });
if (admin) attachWire(server, { events: admin.events, sessions: admin.sessions, log });

server.listen(portalPort, () => {
  log('info', 'portal listening', { port: server.address().port });
});

// A missing/unwritable coin pin must not take the portal and admin down with it.
try {
  const gpio = createGpio(gpioBase);
  gpio.exportPin(coin_pin);
  gpio.watchPin(coin_pin, 'in', 'rising', (value) => {
    if (value !== 1) return;
    const mac = consumePendingPayer();
    if (!mac) {
      log('warn', 'orphan coin pulse: no pending payer', { pin: coin_pin });
      return;
    }
    session.addCredit(mac, pulse_value_pesos, pesos_per_minute);
    if (admin) admin.mainlog.write('system', `Coin: ${pulse_value_pesos} peso(s) credited to ${mac}`);
    try {
      firewall.allow(mac);
      log('info', 'firewall allow', { mac });
    } catch (e) {
      log('error', 'firewall allow failed', { mac, error: e.message });
    }
    session.save();
  });
} catch (e) {
  log('error', 'coin gpio unavailable; portal runs without coin input', { pin: coin_pin, error: e.message });
}

setInterval(() => {
  const due = session.expireDue();
  for (const mac of due) {
    try {
      firewall.revoke(mac);
    } catch (e) {
      log('error', 'firewall revoke failed', { mac, error: e.message });
    }
  }
  if (due.length) session.save();
}, 1000);
```

- [ ] **Step 5: Remove the old admin and its config**

In `lib/config.js` delete the line `  admin: ['username', 'password_hash'],` from `REQUIRED`. Then:

```bash
git rm lib/admin.js test/admin.test.js config/admin.json
```

In `test/config.test.js` delete the line `  'admin.json': { username: 'admin', password_hash: 'x' },` from `GOOD`.

- [ ] **Step 6: Replace `test/portal.test.js`**

The admin-page, login, revoke, credit and log-panel tests are removed (their behaviour now lives in `@nav-44232`, `@nav-89000` and the log handlers, tested in Task 10 and above); two tests are added for the new routing order. Replace the file with:

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../lib/portal');

function fakeSession(active) {
  return {
    isActive: () => active,
    getSession: () => (active ? { mac: 'm1', expiresAt: Date.now() + 60000 } : undefined),
  };
}
function fakeArp(mac) {
  return { ipToMac: () => mac };
}
function recordingArp(mac) {
  const calls = [];
  return { arp: { ipToMac: (ip) => { calls.push(ip); return mac; } }, calls };
}
function sequencedArp(macs) {
  let i = 0;
  return { ipToMac: () => macs[Math.min(i++, macs.length - 1)] };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}
function request(port, method, path, { headers, body: reqBody } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(reqBody);
  });
}
test('client IP is normalized before ARP lookup (IPv6-mapped IPv4 strips the ::ffff: prefix)', async () => {
  const { arp, calls } = recordingArp('m1');
  const { server } = createServer({ session: fakeSession(false), arp, ratePesosPerMinute: 1 });
  const port = await listen(server);
  await request(port, 'GET', '/');
  server.close();
  assert.ok(calls.length >= 1, 'arp.ipToMac was never called');
  assert.ok(!calls[0].startsWith('::ffff:'), `expected a stripped IPv4, got ${calls[0]}`);
});

// Real-frontend ruling: GET / now serves the real app's single SPA shell
// (same for paid/unpaid), matching the actual decrypted frontend's design
// — status is conveyed by client-side JS polling /api/status, never by
// server-rendered HTML branching per state. Supersedes the earlier
// landing/online page split.
test('GET / always serves the real page shell with the real insert-coin button', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /insert coin/i);
  assert.match(res.body, /id="client-insert-coin"/);
  server.close();
});

// Regression: the inline script called toastada.show(msg, type), but the
// real toast.js (public/theme/js/toast.js) only exposes .success/.info/
// .warning/.error -- no .show() at all. That threw inside the click
// handler's success callback in a real browser, silently (no console in
// our Node test runner), making the insert-coin button look broken even
// though the network request itself went through.
test('GET / does not call the nonexistent toastada.show (only real toast.js methods)', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/');
    assert.doesNotMatch(res.body, /toastada\.show\(/);
    assert.match(res.body, /toastada\.(success|info|warning|error)\(/);
  } finally {
    server.close();
  }
});

test('GET / does not throw when the MAC is unresolved (arp returns null)', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp(null), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /insert coin/i);
  server.close();
});

test('POST /api/pay-intent records the pending payer; a single pulse consumes it', async () => {
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'POST', '/api/pay-intent');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(consumePendingPayer(), 'm1');
  server.close();
});

// Ruling (code-review fix pass): the plan's own Interfaces block for Task 4
// said consumePendingPayer "clears it" on first use, but the plan's own
// Review Focus #1 requires back-to-back coin pulses for the SAME payer to
// both credit via top-up. Those two statements contradict each other; the
// spec (binding authority) backs Review Focus #1, so consumePendingPayer
// now "touches" (refreshes) the window on each successful pulse instead of
// clearing it, and only a real TTL lapse (no further pulses) frees the slot.
test('a second pulse for the same payer within TTL still finds the pending payer (supports back-to-back coins)', async () => {
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  try {
    await request(port, 'POST', '/api/pay-intent');
    assert.equal(consumePendingPayer(0), 'm1');
    assert.equal(consumePendingPayer(5000), 'm1'); // second pulse, still within TTL of the first
  } finally {
    server.close();
  }
});

test('the pending payer expires once the TTL truly elapses with no further pulses', async () => {
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  try {
    await request(port, 'POST', '/api/pay-intent');
    assert.equal(consumePendingPayer(0), 'm1');
    assert.equal(consumePendingPayer(20000), null); // no pulse refreshed it; TTL (10s) lapsed
  } finally {
    server.close();
  }
});

test('a different MAC cannot override an active pending payer within TTL', async () => {
  const arp = sequencedArp(['m1', 'm2']);
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp, ratePesosPerMinute: 1 });
  const port = await listen(server);
  try {
    const res1 = await request(port, 'POST', '/api/pay-intent'); // resolves to m1
    const res2 = await request(port, 'POST', '/api/pay-intent'); // resolves to m2, m1 still pending
    assert.deepEqual(JSON.parse(res1.body), { ok: true });
    assert.deepEqual(JSON.parse(res2.body), { ok: false });
    assert.equal(consumePendingPayer(), 'm1');
  } finally {
    server.close();
  }
});

test('consumePendingPayer returns null when none was set', async () => {
  const { server, consumePendingPayer } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  server.close();
  assert.equal(consumePendingPayer(), null);
});

test('GET /api/status reflects active session remaining time', async () => {
  const { server } = createServer({ session: fakeSession(true), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/api/status');
  const body = JSON.parse(res.body);
  assert.equal(body.active, true);
  assert.ok(body.remainingSeconds > 0);
  server.close();
});

test('GET /api/status reflects unpaid', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const res = await request(port, 'GET', '/api/status');
  const body = JSON.parse(res.body);
  assert.equal(body.active, false);
  server.close();
});

test('admin routes answer before any ARP lookup; a request they decline falls through to the portal', async () => {
  const { arp, calls } = recordingArp('m1');
  const seen = [];
  const adminRoutes = (req, res) => {
    seen.push(req.url);
    if (req.url === '/admin') { res.writeHead(200).end('admin'); return true; }
    return false;
  };
  const { server } = createServer({ session: fakeSession(false), arp, ratePesosPerMinute: 1, adminRoutes });
  const port = await listen(server);
  const admin = await request(port, 'GET', '/admin');
  assert.equal(admin.body, 'admin');
  assert.equal(calls.length, 0, 'serving /admin must not shell out to `ip neigh`');
  const other = await request(port, 'GET', '/generate_204');
  assert.match(other.body, /client-insert-coin/);
  assert.deepEqual(seen, ['/admin', '/generate_204']);
  server.close();
});

test('with no admin routes configured the portal still answers (admin unavailable)', async () => {
  const { server } = createServer({ session: fakeSession(false), arp: fakeArp('m1'), ratePesosPerMinute: 1 });
  const port = await listen(server);
  const r = await request(port, 'GET', '/admin');
  assert.match(r.body, /client-insert-coin/);
  server.close();
});
```

- [ ] **Step 7: Update `test/main.test.js`**

Three edits:

1. In `run(env)`, give every spawned server its own state directory so a test never touches the device default (`/mnt/wifi5/vendo5`), which would create directories on a root-run CI machine:

```js
  // every run gets its own state dir: the default (/mnt/wifi5/vendo5) is the device's, never the test machine's
  const p = spawn(process.execPath, [MAIN], { env: { ...process.env, VENDO5_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'v5state-')), ...env } });
```

2. Delete the test `admin login with the default config credentials actually works end to end` together with the comment block above it (starting `// Caught a real bug: main.js passed config.admin`), and delete the whole test `admin revoke, end to end: ...` at the end of the file.
3. In the test `main.js keeps serving the portal when the coin gpio pin is unavailable`, add `VENDO5_STATE_DIR: path.join(dir, 'state'),` to its `env`. (That test listens on the fixed port 3997; make sure nothing else is using it.)

- [ ] **Step 8: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)|^not ok"`
Expected: `# fail 0`, and no `not ok` line. (Roughly 130 tests.)

- [ ] **Step 9: Commit**

```bash
git add -A lib main.js config test
git commit -m "feat: serve the original admin from vendo5 and remove the simple admin

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Check `git status --short` shows nothing left over (in particular no `node_modules`, no `build/`).

### Task 12: Put the frontend and socket.io into the test image

**Files:**
- Create: `scripts/image-commands.js`, `test/image-commands.test.js`
- Modify: `scripts/build-image.sh`

**Interfaces:**
- Produces: `node scripts/image-commands.js` prints debugfs `mkdir` / `write` lines for the app, `config/*.json`, `public/theme`, the **main and nav** frontend folders plus the top-level `.js`/`.ico` files, and the production `node_modules` closure (`npm ls --omit=dev`). The `client`, `sub`, `apk`, `ppoe` frontend folders stay out of the image. On the device the frontend lives at `/opt/vendo5/ui` and the state at `/mnt/wifi5/vendo5`, which are the `main.js` defaults, so `etc/init.d/vendo5` needs no change.

- [ ] **Step 1: Write the failing tests**

Create `test/image-commands.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { walk, commands } = require('../scripts/image-commands');

test('commands creates each directory once, parents before children, then writes every file', () => {
  const lines = commands([
    { src: '/s/a.js', dest: '/opt/vendo5/ui/nav/script/a.js' },
    { src: '/s/b.js', dest: '/opt/vendo5/ui/nav/b.js' },
    { src: '/s/m.js', dest: '/opt/vendo5/main.js' },
  ]);
  const mk = lines.filter((l) => l.startsWith('mkdir'));
  assert.deepEqual(mk, ['mkdir /opt', 'mkdir /opt/vendo5', 'mkdir /opt/vendo5/ui', 'mkdir /opt/vendo5/ui/nav', 'mkdir /opt/vendo5/ui/nav/script']);
  assert.equal(new Set(mk).size, mk.length);
  assert.ok(lines.indexOf('mkdir /opt/vendo5/ui/nav') < lines.indexOf('write /s/a.js /opt/vendo5/ui/nav/script/a.js'));
  assert.equal(lines.filter((l) => l.startsWith('write')).length, 3);
});

test('walk lists regular files recursively and skips symlinks', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v5walk-'));
  fs.mkdirSync(path.join(d, 'x', 'y'), { recursive: true });
  fs.writeFileSync(path.join(d, 'x', 'a.txt'), '1');
  fs.writeFileSync(path.join(d, 'x', 'y', 'b.txt'), '2');
  fs.symlinkSync(path.join(d, 'x', 'a.txt'), path.join(d, 'x', 'link.txt'));
  assert.deepEqual(walk(d, 'x').sort(), [path.join('x', 'a.txt'), path.join('x', 'y', 'b.txt')]);
});

test('debugfs would choke on whitespace in a name; none of the shipped paths has any', () => {
  const ui = require('./helpers/ui-root');
  for (const d of ['main', 'nav']) for (const f of walk(ui, d)) assert.ok(!/\s/.test(f), f);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/image-commands.test.js`
Expected: FAIL, `Cannot find module '../scripts/image-commands'`.

- [ ] **Step 3: Write the generator**

Create `scripts/image-commands.js`:

```js
#!/usr/bin/env node
// Prints the debugfs commands that copy the app, its admin frontend and its runtime dependencies into the
// test image's rootfs: `node scripts/image-commands.js > build/debugfs.cmd`.
// debugfs has no recursive copy, so every directory is a `mkdir` and every file a `write`.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP = '/opt/vendo5';
const UI_SRC = 'legacy/wifi5-soft/frontend-decrypted/public';
const UI_DIRS = ['main', 'nav']; // the login page and the admin shell; client/sub/apk/ppoe stay out
const UI_ROOT_FILES = /\.(js|ico)$/; // socket.io.js and friends sit next to the page folders

// Every regular file under dir, as paths relative to dir (symlinks are skipped: debugfs would copy the target's name only).
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// entries: [{ src, dest }] -> debugfs lines, every parent directory created once, parents first.
function commands(entries) {
  const dirs = new Set();
  for (const { dest } of entries) {
    for (let d = path.posix.dirname(dest); d !== '/' && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
  }
  const mk = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).map((d) => `mkdir ${d}`);
  return [...mk, ...entries.map(({ src, dest }) => `write ${src} ${dest}`)];
}

function entriesFor(root) {
  const out = [];
  const add = (srcDir, destDir, files) => files.forEach((f) => out.push({ src: path.join(srcDir, f), dest: path.posix.join(destDir, f.split(path.sep).join('/')) }));
  add(root, APP, ['main.js', 'package.json', 'package-lock.json']);
  add(root, APP, walk(root, 'lib'));
  add(root, APP, walk(root, 'config').filter((f) => f.endsWith('.json')));
  add(root, APP, walk(root, 'public/theme'));
  const ui = path.join(root, UI_SRC);
  add(ui, `${APP}/ui`, fs.readdirSync(ui, { withFileTypes: true }).filter((e) => e.isFile() && UI_ROOT_FILES.test(e.name)).map((e) => e.name));
  for (const d of UI_DIRS) add(ui, `${APP}/ui`, walk(ui, d));
  // runtime dependencies only (socket.io and what it needs), as npm resolves them
  const deps = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' }).split('\n').filter((p) => p.startsWith(path.join(root, 'node_modules') + path.sep));
  for (const d of [...new Set(deps)]) add(root, APP, walk(root, path.relative(root, d)));
  return out;
}

module.exports = { walk, commands, entriesFor };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  process.stdout.write(commands(entriesFor(root)).join('\n') + '\n');
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test test/image-commands.test.js`
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Use it in the image build**

In `scripts/build-image.sh`, inside the `{ ... } > "$CMD"` group, replace these three lines:

```bash
  echo "mkdir /opt"; echo "mkdir /opt/vendo5"; echo "mkdir /mnt/wifi5"
  for d in lib config public public/theme; do echo "mkdir /opt/vendo5/$d"; done
  for f in main.js package.json lib/*.js config/*.json public/theme/*; do echo "write $f /opt/vendo5/$f"; done
```

with:

```bash
  echo "mkdir /mnt/wifi5"
  node scripts/image-commands.js   # app, config, theme, admin frontend (main+nav) and socket.io, with their directories
```

and make the comment above them read `# app tree`. The script uses the `node_modules` already on disk, so run `npm install` first on a fresh checkout.

- [ ] **Step 6: Build the image and check the filesystem**

Needs `~/Downloads/orangepi-one.img.gz` (the pristine image; the script checks its sha256) and `debugfs`.

Run: `scripts/build-image.sh 2>&1 | tail -5`
Expected: an `e2fsck` summary with no errors (`clean` or a block/inode count line, no `Inode ... has illegal`), then a sha256 line. Then:

```bash
grep -ciE "error|not found|no space" build/debugfs.log
debugfs -R "ls /opt/vendo5/ui" "build/vendo5-orangepi-one-test.img?offset=69206016"
debugfs -R "ls /opt/vendo5/node_modules/socket.io" "build/vendo5-orangepi-one-test.img?offset=69206016"
```

Expected: `0` for the grep (if `mkdir` complains that a directory exists, that is harmless but note it), a listing with `main nav i.ico socket.io.js ...`, and a `socket.io` listing with `package.json` and `dist`. (The image has about 1.3 GB free; the app adds roughly 40 MB.)

- [ ] **Step 7: Commit**

```bash
git add scripts/image-commands.js scripts/build-image.sh test/image-commands.test.js
git commit -m "feat: ship the admin frontend and socket.io in the test image

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 13: Live test in a real browser

**Files:**
- Create: `scripts/live-test.py`

**Interfaces:**
- Produces: `python3 scripts/live-test.py` starts the real `main.js` on port 3996 with fake GPIO, a no-op firewall and seeded sessions and notice, drives headless Firefox through the original login page, and prints `PASS`/`FAIL` lines plus a screenshot directory. Exit code 1 on any failure.

Needs: a Python with `selenium`, Firefox, `geckodriver` (default `/snap/bin/geckodriver`, override with `GECKODRIVER`), free port 3996. On this machine: `~/ETHYLNET-PHASE3/.venv/bin/python`. Do not run it as root.

- [ ] **Step 1: Write the driver**

Create `scripts/live-test.py` (it replaces the driver for the removed simple admin; that one lives on the unmerged branch `fix/dashboard-header-and-focus` and is not carried over):

```python
"""Live test of the vendo5 admin: the real main.js, the original admin frontend, headless Firefox.

Logs in through the original login page (real challenge/response), then checks the dashboard, the session
actions, the logs page, the notification bell and logout, and that the pages raise no JavaScript error and
only ever talk to their own origin. Fake GPIO sysfs and a no-op firewall: nothing touches nft, /mnt or /sys.

Needs: selenium (python), firefox, geckodriver (GECKODRIVER=/path, default /snap/bin/geckodriver), node, free
port 3996. Run from anywhere:   python3 scripts/live-test.py
Screenshots and the server log land in a temp dir that is printed at the end. Exit code 1 if any check fails.
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, 'legacy', 'wifi5-soft', 'frontend-decrypted', 'public')
OUT = tempfile.mkdtemp(prefix='vendo5-live-')
PORT = 3996
URL = f'http://127.0.0.1:{PORT}'
M1, M2 = 'aa:bb:cc:dd:ee:01', '11:22:33:44:55:66'
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'   [{detail}]' if detail and not ok else ''), flush=True)
    return ok


def until(fn, t=10.0, step=0.25):
    end = time.time() + t
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(step)
    return False


def arm(d):
    d.execute_script("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});"
                     "window.addEventListener('unhandledrejection',function(e){window.__errs.push('rej:'+String(e.reason))});")


def errs(d):
    # The dashboard sends its first poll before the system-info reply is back and reads an uptime that is
    # not there yet; the page swallows it and the next poll draws everything. The original did the same.
    return [e for e in d.execute_script('return window.__errs||[]') if 'hg_0x5dce2f is undefined' not in e]


def shot(d, name):
    d.save_screenshot(f'{OUT}/{name}.png')


def foreign_requests(d):
    """Every resource the page loaded that did not come from our own origin."""
    return d.execute_script("return performance.getEntriesByType('resource').map(function(e){return e.name})"
                            ".filter(function(n){return n.indexOf(location.origin)!==0})")


def main():
    now = int(time.time() * 1000)
    seed = {M1: {'mac': M1, 'creditPesos': 2, 'expiresAt': now + 10 * 60000, 'startedAt': now - 90000},
            M2: {'mac': M2, 'creditPesos': 1, 'expiresAt': now + 5 * 60000, 'startedAt': now - 30000}}
    work = tempfile.mkdtemp(dir=OUT)
    os.makedirs(f'{work}/gpio/gpio17')
    for f in ('export', 'unexport', 'gpio17/direction', 'gpio17/edge'):
        open(f'{work}/gpio/{f}', 'w').close()
    open(f'{work}/gpio/gpio17/value', 'w').write('0')
    json.dump(seed, open(f'{work}/sessions.json', 'w'))
    os.makedirs(f'{work}/state')
    json.dump({str(now): {'title': 'Welcome', 'icon': 'mdi-information-outline', 'message': 'First notice', 'read': False}},
              open(f'{work}/state/notification.json', 'w'))
    env = dict(os.environ, VENDO5_CONFIG_DIR=f'{work}/cfg', VENDO5_DEFAULTS_DIR=f'{ROOT}/config', VENDO5_SESSION_FILE=f'{work}/sessions.json',
               VENDO5_STATE_DIR=f'{work}/state', VENDO5_UI_DIR=UI, VENDO5_GPIO_BASE=f'{work}/gpio', VENDO5_PORTAL_PORT=str(PORT),
               VENDO5_FIREWALL_CMD='noop', VENDO5_ARP_FAKE_MAC='aa:bb:cc:dd:ee:99')
    logf = f'{work}/server.log'
    srv = subprocess.Popen(['node', 'main.js'], cwd=ROOT, env=env, stdout=open(logf, 'a'), stderr=subprocess.STDOUT)
    o = Options()
    o.add_argument('-headless')
    d = webdriver.Firefox(options=o, service=Service(os.environ.get('GECKODRIVER', '/snap/bin/geckodriver')))
    d.set_window_size(1280, 900)
    try:
        check('server boots', until(lambda: 'portal listening' in open(logf).read(), 10))
        check('boot logged no error', '"level":"error"' not in open(logf).read(), open(logf).read()[-300:])

        print('\n== LOGIN PAGE ==')
        d.get(URL + '/admin')
        arm(d)
        check('login form is the original (username, password, button)', until(lambda: d.find_element(By.ID, 'login-btn').is_displayed()))
        check('version and code are filled from @main-66322', until(lambda: d.find_element(By.ID, 'version').text.strip() != '' and d.find_element(By.ID, 'prefix').text.strip() != ''))
        shot(d, '1-login')
        d.find_element(By.ID, 'username').send_keys('admin')
        d.find_element(By.ID, 'password').send_keys('wrong')
        d.find_element(By.ID, 'login-btn').click()
        check('wrong password stays on the login page', until(lambda: d.find_element(By.ID, 'error').is_displayed() or '/admin' == d.current_url.replace(URL, '').split('?')[0]))
        check('wrong password did not reach the dashboard', 'page=dashboard' not in d.current_url)
        d.find_element(By.ID, 'password').clear()
        d.find_element(By.ID, 'password').send_keys('admin')
        d.find_element(By.ID, 'login-btn').click()
        check('right password lands on the dashboard', until(lambda: 'page=dashboard' in d.current_url), d.current_url)
        # the login page finishes its own navigation after the redirect; let it settle before clicking around
        until(lambda: d.find_element(By.ID, 'active-client-count'))
        time.sleep(1.5)

        print('\n== DASHBOARD ==')
        arm(d)
        check('menu shows only Dashboard and Logs', until(lambda: sorted(set(a.get_attribute('href').split('page=')[1] for a in d.find_elements(By.CSS_SELECTOR, '#sidebar a[href*="page="], .sidebar a[href*="page="]'))) == ['dashboard', 'logs']),
              str([a.get_attribute('href') for a in d.find_elements(By.CSS_SELECTOR, 'a[href*="page="]')]))
        body = lambda: d.execute_script('return document.body.textContent').lower()  # textContent: rows scroll inside a clipped box
        check('the first seeded session is listed', until(lambda: M1 in body()), body()[:300])
        check('the second seeded session is listed', until(lambda: M2 in body()))
        check('the Active Users count is 2', until(lambda: d.find_element(By.ID, 'active-client-count').text.strip() == '2'))
        check('system info shows an uptime', until(lambda: re.search(r'uptime:\s*\d+:\d+:\d+', body())))
        shot(d, '2-dashboard')

        print('\n== SESSION ACTION ==')
        # the action menu sits behind a "⋮" dropdown on each row; remove the first session through it
        row = d.find_element(By.XPATH, f'//td[contains(translate(., "ABCDEF", "abcdef"), "{M1}")]/ancestor::tr')
        row.find_element(By.CSS_SELECTOR, 'a[data-toggle="dropdown"]').click()
        row.find_element(By.XPATH, './/a[contains(@id, "-remove")]').click()  # Remove acts at once: no confirm dialog in the original
        shot(d, '3-after-remove')
        saved = lambda: json.load(open(f'{work}/sessions.json'))
        check('the session is gone from the file', until(lambda: M1 not in saved() and M2 in saved()), str(list(saved())))
        check('the row disappears from the page', until(lambda: M1 not in body()))
        time.sleep(2)  # the page is still redrawing after the action; a navigation now can be overtaken by it

        print('\n== LOGS ==')
        d.find_element(By.CSS_SELECTOR, 'a.nav-link[href="?page=logs"]').click()  # through the menu, as a person would
        arm(d)
        check('logs page loads (stays logged in)', until(lambda: 'page=logs' in d.current_url))
        sel = until(lambda: next((s for s in d.find_elements(By.CSS_SELECTOR, 'select') if s.is_displayed() and 'system' in (s.get_attribute('id') or '')), None))
        check('a system log date is offered', bool(sel))
        check('the login is in the System Logs table', until(lambda: 'admin success login' in body()), body()[-300:])
        shot(d, '4-logs')
        check('logs page raised no JavaScript error', errs(d) == [], str(errs(d)))

        print('\n== NOTIFICATIONS ==')
        d.get(URL + '/admin?page=dashboard')
        arm(d)
        bell = until(lambda: d.find_element(By.ID, 'notebell'))
        check('unread notice marks the bell', until(lambda: 'count' in (d.find_element(By.ID, 'notebell').get_attribute('class') or '')))
        d.find_element(By.ID, 'notification').click() if d.find_elements(By.ID, 'notification') else bell.click()
        check('the notice title and message are listed (no "undefined")', until(lambda: 'welcome' in body() and 'first notice' in body() and 'undefined' not in body()), body()[-300:])
        check('the notice date is today, not 1970', str(time.localtime().tm_year) in d.find_element(By.ID, 'notification-items').text)
        shot(d, '5-notifications')

        print('\n== PAGE HEALTH ==')
        time.sleep(3)
        check('dashboard raised no JavaScript error', errs(d) == [], str(errs(d)))
        check('every request stayed on our origin', foreign_requests(d) == [], str(foreign_requests(d)))
        for page in ('chat', 'eload-sales', 'phone-rental'):
            d.get(f'{URL}/admin?page={page}')
            check(f'hidden page {page} falls back to the dashboard', until(lambda: 'page=dashboard' in d.current_url))

        check('the server logged no error during the whole run', '"level":"error"' not in open(logf).read(), open(logf).read()[-400:])

        print('\n== LOGOUT ==')
        out = until(lambda: next((e for e in d.find_elements(By.ID, 'logout') if e.is_displayed()), None))
        if not out:
            d.execute_script("document.getElementById('logout').click()")
        else:
            out.click()
        check('logout returns to the login page', until(lambda: d.find_elements(By.ID, 'login-btn')))
        d.get(URL + '/admin?page=dashboard')
        check('dashboard is gone after logout', until(lambda: d.find_elements(By.ID, 'login-btn')))
    finally:
        d.quit()
        srv.terminate()
        print(f'\nartifacts: {OUT}')
    bad = [n for n, ok in results if not ok]
    print(f'\n==== {len(results) - len(bad)}/{len(results)} passed ====')
    sys.exit(1 if bad else 0)


main()
```

- [ ] **Step 2: Run it**

Run: `~/ETHYLNET-PHASE3/.venv/bin/python scripts/live-test.py 2>&1 | grep -E "^(PASS|FAIL)|passed|artifacts"`
Expected: `==== 29/29 passed ====`. If a check fails, open the screenshot in the printed directory before changing anything.

Things that looked like bugs while building this, so you do not chase them again: (a) navigating by typing a URL right after the login redirect can be overtaken by the login page's own navigation, so the driver waits for the dashboard to settle first; (b) the first dashboard poll throws `hg_0x5dce2f is undefined` inside the page, which the driver filters by that exact text; (c) the Dashboard to Logs bounce was the Firefox socket-close race, fixed by the leaving-shim in Task 3, and the driver would catch its return (`logs page loads`).

- [ ] **Step 3: Look at the screenshots**

Open `1-login.png`, `2-dashboard.png`, `4-logs.png`, `5-notifications.png` from the printed directory. Expected: the original WiFi5 Soft login, a dashboard with System Info, a CPU bar chart and two active users, the Logs page with its date selectors, and the bell dropdown showing "Welcome / First notice" with today's date.

- [ ] **Step 4: Commit**

```bash
git add scripts/live-test.py
git commit -m "test: live Firefox test of the original admin on vendo5

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Final check before handing over**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
git log --oneline spec/original-ui-foundation..HEAD
```

Expected: `# fail 0`, and one commit per task (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13). Do not merge to `master`; hand the branch to the user for review.

---

## Deviations from the spec

These were found while building the plan's prototype and are also written into the spec in the same commit. They are listed here because the spec was approved before they were known.

1. **D4's rationale was incomplete.** Storing the password in plaintext is still required (the login hashes in the browser), but the original login page *also* posted the plaintext password in an HTML form to `/admin` after the socket login. The page renderer therefore strips the inputs' `name` attributes at serve time (Task 3), so the password never leaves the page except as a hash.
2. **Logout is `POST /admin` with JSON `{"logout": true}`** (the shell does this), not a socket event.
3. **Menu trimming also covers the navbar chat link, the `#console` button, and four profile items** (system update, software up/down, export/import data) that need later pages or the vendor cloud.
4. **The password hash is computed over the low 8 bits of each character** (latin1), matching the vendor `md5.js`; hashing UTF-8 would lock out any admin whose password has a non-ASCII character.
5. **The original frontend is served from `legacy/...` in development and from `/opt/vendo5/ui` on the device**, selected by `VENDO5_UI_DIR`; it is not `git mv`'d to `public/ui` (85 MB of vendor files stay untouched, and only the `main` and `nav` folders, about 34 MB, go into the image).
6. **A leaving-shim is injected after `socket.io.js`** to stop the shell's disconnect-reload from overtaking a menu navigation in Firefox. It is the only change to the page's behaviour.
7. **Reply shapes are verified by the live test rather than by recorded fixtures** (`test/contract/*.json` is not created): the `Proxy` recorder was used during development to find the real contract (notification keys and `message`, `uploadLimit`/`downloadLimit` strings, `rx`/`tx`, `uptime`), and the live test asserts the effects (rows drawn, uptime shown, notice text and date).
8. **Narrower event set than the spec table**: `@nav-78663` / `@nav-65698` (PPPoE), `@nav-300214` / `@nav-30210` (per-user logs) and `@nav-14433211` are not registered, because no enabled page can send them; the passthrough allowlist is the four lines the dashboard actually uses (the spec's longer list arrives with the network sub-project). `@nav-77833` answers `{client:{clientInfo:[]}}`, the shape the dashboard reads.
9. **Factory reset** clears vendo5's sessions, the login and the notices, keeps the logs as an audit trail, and does not restart the process (the spec said it would also delete logs and exit).
10. **The old admin's "add credit" action has no replacement in this slice.** `@nav-89000` (extend) and `@nav-44232` (remove) cover revoke and time extension; handing out free credit returns with the money engine (sub-project #7), as "create custom session" (`@nav-96549`).
