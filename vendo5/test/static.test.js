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
