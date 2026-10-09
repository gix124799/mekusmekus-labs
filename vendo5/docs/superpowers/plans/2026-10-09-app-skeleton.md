# App Skeleton & Platform Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the vendo5 process skeleton: entrypoint, JSON config loader, sysfs GPIO wrapper, JSON-line logger, and a procd init script.

**Architecture:** Plain CommonJS Node 20, zero dependencies. Each module in `lib/` has one job and takes injectable paths/streams so tests run without hardware. `main.js` wires config + logger and handles SIGTERM/SIGINT.

**Tech Stack:** Node.js v20 (`node:test`, `node:assert`, `fs`), OpenWrt procd.

**Spec:** `docs/superpowers/specs/2026-10-09-app-skeleton-design.md`

## Global Constraints

- Node.js v20.19.5, already on device; no bundler, no npm dependencies (not even dev).
- Install root `/opt/vendo5/`; live config `/mnt/wifi5/vendo5-config/`; shipped defaults `/opt/vendo5/config/`.
- Config files: `network.json`, `vendo.json`, `licensing.json`; merged object keyed by filename stem.
- Logger: one JSON line per call on stdout, `{ts, level, message, ...fields}`, levels `debug|info|warn|error`; no file logging.
- No HTTP server, no vendo/portal/billing logic in this sub-project.
- Init script: `USE_PROCD=1`, `procd_set_param command /usr/bin/node /opt/vendo5/main.js`, `procd_set_param respawn`, stdout/stderr NOT redirected to /dev/null.
- Tests run with `node --test` (no hardware).

## Review Focus

- Config file contains invalid JSON: startup error names the file, not a bare `SyntaxError`. (Task 2)
- Config dir has non-`.json` files or subdirs: ignored. (Task 2)
- Defaults dir missing too on first boot: clear error, not a silent empty config. (Task 2)
- `getConfig()` before `loadConfig()`: throws. (Task 2)
- Pin number not an integer (e.g. `"17; rm"` or `-1`): rejected before touching sysfs paths. (Task 3)
- `exportPin` on an already-exported pin (EBUSY): treated as success. (Task 3)
- `main.js` exits non-zero with a logged error line on bad config. (Task 4)

---

### Task 1: Logger

**Files:**
- Create: `package.json`, `lib/logger.js`
- Test: `test/logger.test.js`

**Interfaces:**
- Produces: `log(level, message, fields = {}, out = process.stdout)`; throws `Error` on unknown level.

- [ ] **Step 1: Write package.json and failing test**

`package.json`:
```json
{
  "name": "vendo5",
  "version": "0.1.0",
  "private": true,
  "main": "main.js",
  "scripts": { "test": "node --test" }
}
```

`test/logger.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { log } = require('../lib/logger');

const sink = () => { const s = { data: '', write(c) { this.data += c; } }; return s; };

test('writes one JSON line with ts, level, message, fields', () => {
  const out = sink();
  log('info', 'hello', { a: 1 }, out);
  assert.ok(out.data.endsWith('\n'));
  const o = JSON.parse(out.data);
  assert.equal(o.level, 'info');
  assert.equal(o.message, 'hello');
  assert.equal(o.a, 1);
  assert.ok(!Number.isNaN(Date.parse(o.ts)));
});

test('fields cannot overwrite level/message/ts', () => {
  const out = sink();
  log('warn', 'm', { level: 'x', message: 'y', ts: 'z' }, out);
  const o = JSON.parse(out.data);
  assert.equal(o.level, 'warn');
  assert.equal(o.message, 'm');
  assert.notEqual(o.ts, 'z');
});

test('unknown level throws', () => {
  assert.throws(() => log('trace', 'm', {}, sink()), /level/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/logger.test.js` — Expected: FAIL, cannot find `../lib/logger`.

- [ ] **Step 3: Implement**

`lib/logger.js`:
```js
const LEVELS = ['debug', 'info', 'warn', 'error'];

function log(level, message, fields = {}, out = process.stdout) {
  if (!LEVELS.includes(level)) throw new Error(`unknown log level: ${level}`);
  out.write(JSON.stringify({ ...fields, ts: new Date().toISOString(), level, message }) + '\n');
}

module.exports = { log, LEVELS };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/logger.test.js` — Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add package.json lib/logger.js test/logger.test.js
git commit -m "feat: add JSON-line logger"
```

---

### Task 2: Config loader

**Files:**
- Create: `lib/config.js`, `config/network.json`, `config/vendo.json`, `config/licensing.json`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(dir, defaultsDir = '/opt/vendo5/config')` → `{network, vendo, licensing}`; `getConfig()` → last loaded config, throws if none. `REQUIRED` map exported. Errors are `Error` with the file name (and key) in the message.

Required keys (minimal; later sub-projects extend): `network: ['lan_interface']`, `vendo: ['coin_pin']`, `licensing: ['mode']`.

- [ ] **Step 1: Write failing test**

`test/config.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, getConfig } = require('../lib/config');

const GOOD = {
  'network.json': { lan_interface: 'br-lan' },
  'vendo.json': { coin_pin: 17 },
  'licensing.json': { mode: 'offline' },
};
function mk(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v5cfg-'));
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(d, n), typeof v === 'string' ? v : JSON.stringify(v));
  return d;
}

test('getConfig before loadConfig throws', () => {
  assert.throws(() => getConfig(), /not loaded/);
});

test('happy path merges by filename stem and caches', () => {
  const cfg = loadConfig(mk(GOOD), '/nonexistent');
  assert.equal(cfg.vendo.coin_pin, 17);
  assert.equal(cfg.network.lan_interface, 'br-lan');
  assert.strictEqual(getConfig(), cfg);
});

test('missing required key names file and key', () => {
  const d = mk({ ...GOOD, 'vendo.json': {} });
  assert.throws(() => loadConfig(d, '/nonexistent'), /vendo\.json.*coin_pin/);
});

test('missing required file is an error', () => {
  const { 'licensing.json': _, ...rest } = GOOD;
  assert.throws(() => loadConfig(mk(rest), '/nonexistent'), /licensing\.json/);
});

test('invalid JSON names the file', () => {
  const d = mk({ ...GOOD, 'network.json': '{oops' });
  assert.throws(() => loadConfig(d, '/nonexistent'), /network\.json/);
});

test('non-json files and subdirs are ignored', () => {
  const d = mk(GOOD);
  fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(d, 'sub.json'));
  assert.doesNotThrow(() => loadConfig(d, '/nonexistent'));
});

test('missing dir: defaults are copied then loaded', () => {
  const defaults = mk(GOOD);
  const target = path.join(os.tmpdir(), 'v5cfg-new-' + process.pid);
  fs.rmSync(target, { recursive: true, force: true });
  const cfg = loadConfig(target, defaults);
  assert.equal(cfg.vendo.coin_pin, 17);
  assert.ok(fs.existsSync(path.join(target, 'vendo.json')));
});

test('empty dir: defaults are copied', () => {
  const defaults = mk(GOOD);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'v5cfg-empty-'));
  assert.equal(loadConfig(target, defaults).licensing.mode, 'offline');
});

test('first boot with no defaults dir is a clear error', () => {
  const target = path.join(os.tmpdir(), 'v5cfg-nodef-' + process.pid);
  fs.rmSync(target, { recursive: true, force: true });
  assert.throws(() => loadConfig(target, '/nonexistent-defaults'), /defaults/);
});
```

Note: the "getConfig before loadConfig" test must run first in this file (node:test runs in order within a file; it is first).

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/config.test.js` — Expected: FAIL, cannot find `../lib/config`.

- [ ] **Step 3: Implement**

`lib/config.js`:
```js
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED = {
  network: ['lan_interface'],
  vendo: ['coin_pin'],
  licensing: ['mode'],
};

let loaded = null;

const jsonFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);

function seedDefaults(dir, defaultsDir) {
  if (!fs.existsSync(defaultsDir)) throw new Error(`config dir ${dir} is empty and defaults dir ${defaultsDir} does not exist`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of jsonFiles(defaultsDir)) fs.copyFileSync(path.join(defaultsDir, f), path.join(dir, f));
}

function loadConfig(dir, defaultsDir = '/opt/vendo5/config') {
  if (!fs.existsSync(dir) || jsonFiles(dir).length === 0) seedDefaults(dir, defaultsDir);
  const cfg = {};
  for (const f of jsonFiles(dir)) {
    try {
      cfg[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      throw new Error(`config ${f}: ${e.message}`);
    }
  }
  for (const [stem, keys] of Object.entries(REQUIRED)) {
    if (!cfg[stem]) throw new Error(`config ${stem}.json: file missing`);
    for (const k of keys) {
      if (!(k in cfg[stem])) throw new Error(`config ${stem}.json: missing required key "${k}"`);
    }
  }
  loaded = cfg;
  return cfg;
}

function getConfig() {
  if (!loaded) throw new Error('config not loaded: call loadConfig first');
  return loaded;
}

module.exports = { loadConfig, getConfig, REQUIRED };
```

`config/network.json`: `{ "lan_interface": "br-lan" }`
`config/vendo.json`: `{ "coin_pin": 17 }`
`config/licensing.json`: `{ "mode": "offline" }`

(`coin_pin` 17 is a placeholder; sub-project #2 sets the real Orange Pi One pin.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/config.test.js` — Expected: 9 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/config.js config test/config.test.js
git commit -m "feat: add config loader with default seeding and validation"
```

---

### Task 3: GPIO wrapper

**Files:**
- Create: `lib/gpio.js`
- Test: `test/gpio.test.js`

**Interfaces:**
- Consumes: `log` from `lib/logger.js` (Task 1).
- Produces: `createGpio(base = '/sys/class/gpio')` → `{ exportPin(pin), unexportPin(pin), readPin(pin) → 0|1, watchPin(pin, direction, edge, callback) → stop() }`. `callback(value)` on change; watcher errors are logged and `stop()` called. Pin must be a non-negative integer else `Error('invalid pin: ...')`. Errors include pin number and sysfs path.

- [ ] **Step 1: Write failing test**

`test/gpio.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGpio } = require('../lib/gpio');

// Fake sysfs: export/unexport files; writing "N" to export creates gpioN/ with value, direction, edge.
function fakeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v5gpio-'));
  fs.writeFileSync(path.join(base, 'export'), '');
  fs.writeFileSync(path.join(base, 'unexport'), '');
  return base;
}
function makePin(base, n, value = '0') {
  const d = path.join(base, `gpio${n}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'value'), value);
  fs.writeFileSync(path.join(d, 'direction'), '');
  fs.writeFileSync(path.join(d, 'edge'), '');
  return d;
}

test('exportPin writes pin number to export', () => {
  const base = fakeBase();
  createGpio(base).exportPin(17);
  assert.equal(fs.readFileSync(path.join(base, 'export'), 'utf8'), '17');
});

test('unexportPin writes pin number to unexport', () => {
  const base = fakeBase();
  createGpio(base).unexportPin(17);
  assert.equal(fs.readFileSync(path.join(base, 'unexport'), 'utf8'), '17');
});

test('readPin returns 0/1 as number', () => {
  const base = fakeBase();
  makePin(base, 5, '1\n');
  assert.strictEqual(createGpio(base).readPin(5), 1);
});

test('invalid pins rejected before touching sysfs', () => {
  const g = createGpio(fakeBase());
  for (const bad of [-1, 1.5, '17; rm', NaN, undefined]) {
    assert.throws(() => g.exportPin(bad), /invalid pin/);
  }
});

test('exportPin error names pin and path', () => {
  const g = createGpio('/nonexistent-sysfs');
  assert.throws(() => g.exportPin(3), /pin 3.*\/nonexistent-sysfs\/export/);
});

test('exportPin treats EBUSY as already exported', () => {
  const base = fakeBase();
  const fsx = { ...fs, writeFileSync() { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
  assert.doesNotThrow(() => createGpio(base, fsx).exportPin(4));
});

test('watchPin sets direction/edge and fires callback on change; stop unwatches', async () => {
  const base = fakeBase();
  const d = makePin(base, 9, '0');
  const seen = [];
  const stop = createGpio(base).watchPin(9, 'in', 'both', (v) => seen.push(v));
  assert.equal(fs.readFileSync(path.join(d, 'direction'), 'utf8'), 'in');
  assert.equal(fs.readFileSync(path.join(d, 'edge'), 'utf8'), 'both');
  fs.writeFileSync(path.join(d, 'value'), '1');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(seen.includes(1));
  stop();
  assert.equal(fs.readFileSync(path.join(base, 'unexport'), 'utf8'), '9');
  const n = seen.length;
  fs.writeFileSync(path.join(d, 'value'), '0');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen.length, n);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/gpio.test.js` — Expected: FAIL, cannot find `../lib/gpio`.

- [ ] **Step 3: Implement**

`lib/gpio.js`:
```js
const nodeFs = require('node:fs');
const path = require('node:path');
const { log } = require('./logger');

// shortcut: fs.watch (inotify on sysfs) instead of a native epoll addon; a few ms more latency,
// fine for coin pulses tens of ms wide. Revisit only if sub-project #2 hardware tests miss pulses.
function createGpio(base = '/sys/class/gpio', fs = nodeFs) {
  const check = (pin) => {
    if (!Number.isInteger(pin) || pin < 0) throw new Error(`invalid pin: ${pin}`);
    return pin;
  };
  const write = (file, data, pin) => {
    try {
      fs.writeFileSync(file, String(data));
    } catch (e) {
      if (e.code === 'EBUSY') return; // already (un)exported
      throw new Error(`gpio pin ${pin}: write ${file} failed: ${e.message}`);
    }
  };
  const pinDir = (pin) => path.join(base, `gpio${pin}`);

  const exportPin = (pin) => write(path.join(base, 'export'), check(pin), pin);
  const unexportPin = (pin) => write(path.join(base, 'unexport'), check(pin), pin);
  const readPin = (pin) => {
    const file = path.join(pinDir(check(pin)), 'value');
    try {
      return Number(fs.readFileSync(file, 'utf8').trim());
    } catch (e) {
      throw new Error(`gpio pin ${pin}: read ${file} failed: ${e.message}`);
    }
  };

  function watchPin(pin, direction, edge, callback) {
    check(pin);
    const dir = pinDir(pin);
    write(path.join(dir, 'direction'), direction, pin);
    write(path.join(dir, 'edge'), edge, pin);
    let watcher = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (watcher) watcher.close();
      try { unexportPin(pin); } catch (e) { log('warn', e.message, { pin }); }
    };
    watcher = fs.watch(path.join(dir, 'value'), () => {
      try { callback(readPin(pin)); } catch (e) { log('error', e.message, { pin }); }
    });
    watcher.on('error', (e) => { log('error', `gpio pin ${pin}: watch failed: ${e.message}`, { pin }); stop(); });
    return stop;
  }

  return { exportPin, unexportPin, readPin, watchPin };
}

module.exports = { createGpio };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/gpio.test.js` — Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/gpio.js test/gpio.test.js
git commit -m "feat: add sysfs GPIO wrapper"
```

---

### Task 4: Entrypoint, smoke test, init script

**Files:**
- Create: `main.js`, `etc/init.d/vendo5`
- Test: `test/main.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 2), `log` (Task 1).
- Produces: `main.js` run as a process. Env overrides: `VENDO5_CONFIG_DIR` (default `/mnt/wifi5/vendo5-config`), `VENDO5_DEFAULTS_DIR` (default `/opt/vendo5/config`; passed through to `loadConfig`). Logs `"vendo5 started"` with `{version, config: [stems]}`; on SIGTERM/SIGINT logs `"vendo5 stopping"` and exits 0; on config error logs `error` line and exits 1.

- [ ] **Step 1: Write failing test**

`test/main.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/main.test.js` — Expected: FAIL (main.js missing; process exits non-zero / no startup line).

- [ ] **Step 3: Implement**

`main.js`:
```js
const { loadConfig } = require('./lib/config');
const { log } = require('./lib/logger');
const { version } = require('./package.json');

const configDir = process.env.VENDO5_CONFIG_DIR || '/mnt/wifi5/vendo5-config';
const defaultsDir = process.env.VENDO5_DEFAULTS_DIR || '/opt/vendo5/config';

let config;
try {
  config = loadConfig(configDir, defaultsDir);
} catch (e) {
  log('error', e.message);
  process.exit(1);
}

log('info', 'vendo5 started', { version, config: Object.keys(config) });

const shutdown = () => { log('info', 'vendo5 stopping'); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep the event loop alive; later sub-projects attach real work here.
setInterval(() => {}, 1 << 30);
```

`etc/init.d/vendo5`:
```sh
#!/bin/sh /etc/rc.common

START=95
STOP=10
USE_PROCD=1

start_service() {
	procd_open_instance
	procd_set_param command /usr/bin/node /opt/vendo5/main.js
	procd_set_param respawn
	procd_set_param stdout 1
	procd_set_param stderr 1
	procd_close_instance
}
```

- [ ] **Step 4: Run full suite**

Run: `chmod +x etc/init.d/vendo5 && node --test` — Expected: all tests (3 + 9 + 7 + 2) pass.

- [ ] **Step 5: Commit**

```bash
git add main.js etc/init.d/vendo5 test/main.test.js
git commit -m "feat: add entrypoint, smoke test and procd init script"
```

---

## Self-Review

- Spec coverage: entrypoint/graceful stop (T4), config loader + first-boot seeding + validation (T2), GPIO export/unexport/read/watch + error handling (T3), logger (T1), procd script (T4), tests for each (all). Deploy/copy to `/opt/vendo5` on the device is out of scope for the spec's code deliverables.
- Not verified here: real sysfs/inotify behavior and the procd script need the Orange Pi (spec defers hardware to sub-project #2).
- Types: `loadConfig(dir, defaultsDir)`, `log(level, message, fields, out)`, `createGpio(base, fs)` consistent across tasks.
