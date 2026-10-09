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

// Task 5 added real-hardware gpio.exportPin to main.js's startup path; any
// test that reaches that far now needs a fake sysfs dir (matching the
// default vendo.json's coin_pin: 17), same as the dedicated portal test below.
function fakeGpioBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v5gpiobase-'));
  fs.writeFileSync(path.join(base, 'export'), '');
  fs.writeFileSync(path.join(base, 'unexport'), '');
  const pinDir = path.join(base, 'gpio17');
  fs.mkdirSync(pinDir, { recursive: true });
  fs.writeFileSync(path.join(pinDir, 'value'), '0');
  fs.writeFileSync(path.join(pinDir, 'direction'), '');
  fs.writeFileSync(path.join(pinDir, 'edge'), '');
  return base;
}

test('starts, logs startup line, exits 0 on SIGTERM', async () => {
  const r = run({
    VENDO5_CONFIG_DIR: tmpDir(),
    VENDO5_DEFAULTS_DIR: DEFAULTS,
    VENDO5_GPIO_BASE: fakeGpioBase(),
    VENDO5_PORTAL_PORT: '0',
  });
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

test('vendo config missing pricing fields fails startup (extends required-key validation)', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  // seed network.json/licensing.json from defaults so only vendo.json is
  // incomplete — otherwise the file-missing check for an unrelated config
  // (checked first) fires before vendo's own required-key check does.
  for (const f of fs.readdirSync(DEFAULTS)) fs.copyFileSync(path.join(DEFAULTS, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'vendo.json'), JSON.stringify({ coin_pin: 17 }));
  const r = run({ VENDO5_CONFIG_DIR: dir, VENDO5_DEFAULTS_DIR: DEFAULTS });
  assert.equal(await r.exited, 1);
  assert.match(r.out(), /"level":"error".*vendo\.json/);
});

test('portal listens and serves the landing page; coin pulse with no pay-intent is refused and logged', async () => {
  const configDir = tmpDir();
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5sessfile-')), 'sessions.json');
  const gpioBase = fs.mkdtempSync(path.join(os.tmpdir(), 'v5gpiobase-'));
  fs.writeFileSync(path.join(gpioBase, 'export'), '');
  fs.writeFileSync(path.join(gpioBase, 'unexport'), '');
  const pinDir = path.join(gpioBase, 'gpio17');
  fs.mkdirSync(pinDir, { recursive: true });
  fs.writeFileSync(path.join(pinDir, 'value'), '0');
  fs.writeFileSync(path.join(pinDir, 'direction'), '');
  fs.writeFileSync(path.join(pinDir, 'edge'), '');

  const r = run({
    VENDO5_CONFIG_DIR: configDir,
    VENDO5_DEFAULTS_DIR: DEFAULTS,
    VENDO5_SESSION_FILE: sessionFile,
    VENDO5_GPIO_BASE: gpioBase,
    VENDO5_PORTAL_PORT: '0', // ephemeral; main.js logs the actual bound port
    VENDO5_FIREWALL_CMD: 'noop',
  });
  await new Promise((res) => r.p.stdout.once('data', res));
  // settle: the first stdout line doesn't guarantee the gpio fs.watch
  // (inotify) registration is live yet; without this the write below
  // races the watcher setup and the pulse is silently missed.
  await new Promise((res) => setTimeout(res, 50));

  // trigger a coin pulse with no pending pay-intent
  fs.writeFileSync(path.join(pinDir, 'value'), '1');
  await new Promise((res) => setTimeout(res, 200));

  r.p.kill('SIGTERM');
  await r.exited;
  assert.match(r.out(), /"level":"warn".*orphan/i);
});
