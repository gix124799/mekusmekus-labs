const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAIN = path.join(__dirname, '..', 'main.js');
const DEFAULTS = path.join(__dirname, '..', 'config');

function run(env) {
  const p = spawn(process.execPath, [MAIN], { env: { ...process.env, ...env } });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  return { p, exited, out: () => out };
}
const tmpDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5main-')), 'cfg');

test('starts, logs startup line, exits 0 on SIGTERM', async () => {
  const r = run({ VENDO5_CONFIG_DIR: tmpDir(), VENDO5_DEFAULTS_DIR: DEFAULTS });
  await new Promise((res) => r.p.stdout.once('data', res));
  assert.match(r.out(), /"message":"vendo5 started"/);
  r.p.kill('SIGTERM');
  assert.equal(await r.exited, 0);
  assert.match(r.out(), /"message":"vendo5 stopping"/);
});

test('bad config: logs error line and exits 1', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendo.json'), '{}');
  const r = run({ VENDO5_CONFIG_DIR: dir, VENDO5_DEFAULTS_DIR: DEFAULTS });
  assert.equal(await r.exited, 1);
  assert.match(r.out(), /"level":"error".*(licensing|network|vendo)\.json/);
});
