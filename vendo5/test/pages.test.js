const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPages, trimMenu, trimNavbar, trimProfile, stripLoginNames, endOfLi } = require('../lib/ui/pages');

const ROOT = require('./helpers/ui-root');
const pages = () => createPages({ root: ROOT, version: '1.2.3', hostname: 'vendo-one', enabled: ['dashboard', 'logs'] });
const count = (s, re) => (s.match(re) || []).length;
const links = (html) => [...html.matchAll(/href="\?page=([\w-]+)"/g)].map((m) => m[1]);

test('shell: placeholders are filled and the page script is selected', () => {
  const html = pages().renderShell('dashboard');
  const css = fs.readFileSync(path.join(ROOT, 'nav/assets/css/style.css'), 'utf8');
  assert.ok(html.includes('/nav/script/dashboard.js?version=1.2.3&design=4'));
  assert.ok(html.includes('/nav/assets/css/style.css?version=1.2.3&design=5'));
  assert.ok(html.includes('<img src="/theme/banner.jpg" alt="logo" style="object-fit: contain;" />'));
  assert.match(css, /\.card \{[^}]*border: 1px solid rgba\(0, 191, 255, 0\.55\);/s);
  assert.match(css, /\.card \.card-body \{[^}]*border: 1px solid rgba\(0, 191, 255, 0\.55\);/s);
  assert.match(css, /\.card \.card-footer \{[^}]*border: 1px solid rgba\(0, 191, 255, 0\.55\);/s);
  assert.match(css, /\.card \.card-footer \{[^}]*border-radius: 0\.5rem;/s);
  assert.ok(html.includes('Admin| VENDO-ONE'));
  for (const left of ['{1}', '{2}', '@script.js']) assert.ok(!html.includes(left), `${left} left in the page`);
  assert.ok(pages().renderShell('logs').includes('/nav/script/logs.js?version=1.2.3&design=4'));
});

test('dashboard uptime starts at zero until the asynchronous system-info response arrives', () => {
  const script = fs.readFileSync(path.join(ROOT, 'nav/script/dashboard.js'), 'utf8');
  assert.match(script, /let hg_0x5dce2f=\{uptime:0\}/);
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

test('shell: the profile menu shows every item by default, and can hide chosen ones', () => {
  const all = pages().renderShell('dashboard');
  for (const id of ['system-update', 'software-updown', 'export-data', 'import-data', 'clear-all-data', 'license', 'change-pass', 'system-reboot', 'logout']) assert.ok(all.includes(`id="${id}"`), id);
  const html = createPages({ root: ROOT, version: '1', hostname: 'h', enabled: ['dashboard'], hiddenProfileItems: ['system-update', 'software-updown', 'export-data', 'import-data'] }).renderShell('dashboard');
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
  const css = fs.readFileSync(path.join(ROOT, 'main/css/style.css'), 'utf8');
  assert.ok(html.includes('<h3 style="text-transform: capitalize;">MEKUSMEKUS</h3>'));
  assert.ok(!html.includes('{1}') && !html.includes('{2}'));
  assert.ok(html.includes('/main/css/style.css?version=1.2.3&design=3'));
  assert.ok(!css.includes('banner.jpg'));
  assert.match(css, /#071323/);
  assert.match(css, /#00bfff/);
  assert.match(css, /border: 1px solid rgba\(0, 191, 255, 0\.55\);/);
  assert.match(css, /#ffbd2e/);
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
