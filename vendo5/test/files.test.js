const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createFileArea, MAX_FILE } = require('../lib/system/files');
const { createFileHandlers } = require('../lib/wire/files');

const area = () => { const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5fa-')), 'files'); return { root, a: createFileArea({ root }) }; };

test('save then list/rename/remove, all by URL-style paths', async () => {
  const { a, root } = area();
  assert.deepEqual(a.list('/files'), []);
  assert.equal(await a.save('/files/site', 'index.html', Readable.from(['<h1>', 'hi</h1>'])), true);
  assert.equal(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8'), '<h1>hi</h1>');
  assert.deepEqual(a.list('/files').map((e) => [e.name, e.type]), [['site', 'directory']]);
  const f = a.list('/files/site')[0];
  assert.deepEqual([f.name, f.type, f.size], ['index.html', 'file', 11]);
  assert.equal(a.rename('/files/site/index.html', '/files/site/home.html'), true);
  assert.equal(a.rename('/files/site/home.html', '/files/site/home.exe'), false, 'a file cannot take a dangerous extension');
  assert.equal(a.remove('/files/site/home.html'), true);
  assert.equal(a.remove('/files/site/home.html'), false);
  assert.equal(a.remove('/files'), false, 'the root itself is never removed');
});

test('nothing escapes the root: traversal, odd names, wrong prefix, absolute paths, deep nesting', async () => {
  const { a, root } = area();
  fs.writeFileSync(path.join(path.dirname(root), 'secret.txt'), 's');
  for (const bad of ['/files/../secret.txt', '/files/a/../../secret.txt', '/files/%2e%2e/x', '/etc/passwd', 'files/x', '/filesx', '/files//..', '/files/.hidden', '/files/a b/../..', '/files/' + 'a/'.repeat(10), null, 5]) {
    assert.equal(a.resolve(bad), null, String(bad));
    assert.equal(a.list(bad), null);
    assert.equal(a.remove(bad), false);
    assert.equal(a.rename(bad, '/files/x.txt'), false);
  }
  assert.equal(await a.save('/files/../x', 'a.html', Readable.from(['x'])), false);
  assert.equal(await a.save('/files', '../a.html', Readable.from(['x'])), false);
  assert.equal(await a.save('/files', 'a.php', Readable.from(['x'])), false, 'extension allowlist');
  assert.equal(await a.save('/files', 'a.html.exe', Readable.from(['x'])), false);
  assert.equal(fs.readFileSync(path.join(path.dirname(root), 'secret.txt'), 'utf8'), 's');
});

test('an upload over the size limit leaves nothing behind, and a name that is a directory is refused', async () => {
  const { a, root } = area();
  const big = Readable.from((function* () { for (let i = 0; i < 21; i++) yield Buffer.alloc(1024 * 1024); })());
  assert.equal(await a.save('/files', 'big.png', big), false);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.mkdirSync(path.join(root, 'dir.html'));
  assert.equal(await a.save('/files', 'dir.html', Readable.from(['x'])), false);
  assert.ok(MAX_FILE >= 20 * 1024 * 1024);
});

test('wire handlers: remove/rename answer {} or {code}, upload takes the full target path; junk is {code:1}', async () => {
  const { a, root } = area();
  const lines = [];
  const h = createFileHandlers({ area: a, mainlog: { write: (c, t) => lines.push(t) } });
  assert.equal(h['@nav-099283799'].stream, true);
  assert.deepEqual(await h['@nav-099283799'].handler({ stream: Readable.from(['x']), data: { path: '/files/pppoe/logo.png' } }), {});
  assert.ok(fs.existsSync(path.join(root, 'pppoe', 'logo.png')));
  assert.deepEqual(await h['@nav-099283799'].handler({ stream: Readable.from(['x']), data: { path: '/files/../evil.png' } }), { code: 1 });
  assert.deepEqual(await h['@nav-099283799'].handler({ stream: Readable.from(['x']), data: null }), { code: 1 });
  assert.deepEqual(h['@nav-0992837'].handler({ rename: true, oldname: '/files/pppoe/logo.png', newname: '/files/pppoe/brand.png' }), {});
  assert.deepEqual(h['@nav-0992837'].handler({ remove: true, path: '/files/pppoe/brand.png', type: 'file' }), {});
  for (const bad of [null, {}, { remove: true, path: '/files/nope' }, { rename: true, oldname: '/x', newname: '/y' }]) assert.deepEqual(h['@nav-0992837'].handler(bad), { code: 1 }, JSON.stringify(bad));
  assert.ok(lines.some((l) => /uploaded logo.png/.test(l)) && lines.some((l) => /renamed/.test(l)));
});
