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
