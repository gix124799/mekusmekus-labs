const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportConfig, importConfig, FORMAT } = require('../lib/system/sysconfig');
const { bodyToFile, extractFilePart } = require('../lib/system/upload');
const { applyUpdate } = require('../lib/system/appupdate');
const { execFileSync } = require('node:child_process');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v5sys-'));
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

test('export then import into a fresh directory restores every data file and nothing else', () => {
  const a = tmp();
  put(a, 'account.json', '{"main":{"username":"admin","password":"x"}}');
  put(a, 'settings.json', '{"a":1}');
  put(a, 'vouchers/list.json', '{}');
  put(a, 'mainlogs/system-01-01-2026.txt', '10:00:00 am: hi\n');
  put(a, 'device-id', 'abcd');
  put(a, 'notes.txt', 'not data');
  const b = tmp();
  const blob = exportConfig(a, '1.0.0', () => 5);
  const doc = JSON.parse(blob);
  assert.deepEqual([doc.format, doc.version, doc.created], [FORMAT, '1.0.0', 5]);
  assert.ok(!('device-id' in doc.files) && !('notes.txt' in doc.files), 'the device id and stray files stay out');
  assert.deepEqual(importConfig(b, blob), { ok: true, count: 4 });
  assert.equal(fs.readFileSync(path.join(b, 'settings.json'), 'utf8'), '{"a":1}');
  assert.equal(fs.readFileSync(path.join(b, 'mainlogs/system-01-01-2026.txt'), 'utf8'), '10:00:00 am: hi\n');
  assert.equal(fs.statSync(path.join(b, 'account.json')).mode & 0o777, 0o600, 'the account file stays private');
});

test('import refuses anything that is not a clean backup and writes nothing', () => {
  const d = tmp();
  const doc = (files, extra = {}) => Buffer.from(JSON.stringify({ format: FORMAT, files, ...extra }));
  const b64 = (s) => Buffer.from(s).toString('base64');
  const bad = [
    ['garbage', Buffer.from('not json')],
    ['wrong format', Buffer.from(JSON.stringify({ format: 'other', files: { 'settings.json': b64('{}') } }))],
    ['no files', doc({})],
    ['traversal', doc({ '../evil.json': b64('{}') })],
    ['nested traversal', doc({ 'vouchers/../../evil': b64('x') })],
    ['absolute', doc({ '/etc/passwd': b64('x') })],
    ['unknown name', doc({ 'main.js': b64('x') })],
    ['unknown dir', doc({ 'lib/x.js': b64('x') })],
    ['non-string content', doc({ 'settings.json': 5 })],
    ['damaged json', doc({ 'settings.json': b64('{nope') })],
    ['array files', Buffer.from(JSON.stringify({ format: FORMAT, files: [] }))],
  ];
  for (const [name, blob] of bad) assert.equal(importConfig(d, blob).ok, false, name);
  assert.deepEqual(fs.readdirSync(d), [], 'nothing was written');
  assert.equal(fs.existsSync(path.join(path.dirname(d), 'evil.json')), false);
});

test('a multipart upload is streamed to disk and its file part extracted byte-for-byte, binary included', async () => {
  const dir = tmp();
  const payload = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255, 254, 13, 10, 13, 10, 7]);
  const boundary = '----WebKitFormBoundaryabc123';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), payload, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const { Readable } = require('node:stream');
  const req = Readable.from([body.subarray(0, 20), body.subarray(20)]);
  const raw = path.join(dir, 'raw');
  assert.equal(await bodyToFile(req, raw, 1000000), body.length);
  const out = path.join(dir, 'part');
  assert.equal(await extractFilePart(raw, `multipart/form-data; boundary=${boundary}`, out), payload.length);
  assert.deepEqual(fs.readFileSync(out), payload);
  assert.equal(await extractFilePart(raw, 'multipart/form-data', out), null, 'no boundary');
  assert.equal(await extractFilePart(raw, 'multipart/form-data; boundary=zzz', out), null, 'boundary not found');
});

test('an upload over the limit is refused and leaves no file behind', async () => {
  const dir = tmp();
  const { Readable } = require('node:stream');
  const raw = path.join(dir, 'raw');
  assert.equal(await bodyToFile(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), raw, 1000), null);
  assert.equal(fs.existsSync(raw), false);
});

function makeTar(files, extra = '') {
  const src = tmp();
  for (const [n, c] of Object.entries(files)) put(src, n, c);
  const out = path.join(tmp(), 'u.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', src, ...Object.keys(files).map((n) => n.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i), ...(extra ? [extra] : [])]);
  return out;
}
const run = (args) => execFileSync(args[0], args.slice(1), { encoding: 'utf8' });
const appDirWith = (files) => { const d = path.join(tmp(), 'app'); for (const [n, c] of Object.entries(files)) put(d, n, c); return d; };

test('a good update archive replaces the app, keeps the old one as .prev, and reports its version', () => {
  const app = appDirWith({ 'main.js': '// old\n', 'package.json': '{"name":"vendo5","version":"0.1.0"}' });
  const tar = makeTar({ 'main.js': '// new\n', 'package.json': '{"name":"vendo5","version":"0.2.0"}', 'lib/a.js': 'x' });
  assert.deepEqual(applyUpdate({ archive: tar, appDir: app, runCommand: run }), { ok: true, version: '0.2.0' });
  assert.equal(fs.readFileSync(path.join(app, 'main.js'), 'utf8'), '// new\n');
  assert.equal(fs.readFileSync(path.join(app + '.prev', 'main.js'), 'utf8'), '// old\n');
  assert.equal(fs.existsSync(app + '.new'), false);
});

test('a bad archive never touches the installed app', () => {
  const old = { 'main.js': '// old\n', 'package.json': '{"name":"vendo5","version":"0.1.0"}' };
  const cases = {
    'not an archive': () => { const f = path.join(tmp(), 'x.tar.gz'); fs.writeFileSync(f, 'junk'); return f; },
    'no main.js': () => makeTar({ 'package.json': '{"name":"vendo5"}' }),
    'wrong package': () => makeTar({ 'main.js': '//', 'package.json': '{"name":"other"}' }),
    'syntax error in main.js': () => makeTar({ 'main.js': 'function (', 'package.json': '{"name":"vendo5"}' }),
    'a symlink': () => { const src = tmp(); put(src, 'main.js', '//'); put(src, 'package.json', '{"name":"vendo5"}'); fs.symlinkSync('/etc/passwd', path.join(src, 'link')); const out = path.join(tmp(), 'l.tar.gz'); execFileSync('tar', ['-czf', out, '-C', src, 'main.js', 'package.json', 'link']); return out; },
  };
  for (const [name, make] of Object.entries(cases)) {
    const app = appDirWith(old);
    const r = applyUpdate({ archive: make(), appDir: app, runCommand: run });
    assert.equal(r.ok, false, name);
    assert.equal(fs.readFileSync(path.join(app, 'main.js'), 'utf8'), '// old\n', name);
    assert.equal(fs.existsSync(app + '.new'), false, `${name}: staging cleaned up`);
  }
});

test('an archive with a path that climbs out is refused before anything is unpacked', () => {
  const app = appDirWith({ 'main.js': '// old\n', 'package.json': '{"name":"vendo5"}' });
  const fake = (args) => (args[1] === '-tzf' ? 'main.js\npackage.json\n../../evil\n' : run(args));
  const r = applyUpdate({ archive: '/dev/null', appDir: app, runCommand: fake });
  assert.deepEqual(r, { ok: false, error: 'Unsafe path in the archive' });
});
