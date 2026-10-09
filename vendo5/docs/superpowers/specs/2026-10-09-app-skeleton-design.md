# Sub-project #1: App Skeleton & Platform Services

Status: draft, pending review
Project: MekusMekus Labs — vendo5 (replacement app for WiFi5-Soft `/soft`)
Part of: full vendo/hotspot/PPPoE firmware app rebuild (see decomposition in chat history)

## Purpose

Provide the foundation every later sub-project (captive-portal vendo, PPPoE/RADIUS,
admin dashboard, reseller, licensing, payment) builds on. No vendo/portal/billing
logic lives here — this is process lifecycle, config, GPIO access, and logging only.

Target device: Orange Pi One, OpenWrt base unchanged (WiFi5-Soft 24.10.4,
sunxi/cortexa7, musl armhf). Node.js v20.19.5 already installed via the
distro's own `node115` opkg package — no bundler, no cross-compiled runtime.

## Scope

In scope:
- Process entrypoint (`main.js`) and graceful start/stop
- Config loader: reads JSON config files from a fixed directory, validates
  required fields, exposes a typed accessor
- GPIO module: sysfs export/unexport/read/poll wrapper (edge-triggered)
- Logger: structured JSON lines to stdout
- procd init script to run it as a respawning service
- A startup smoke test

Out of scope (future sub-projects): captive portal, vendo credit logic,
PPPoE/RADIUS, admin dashboard, reseller, licensing, payment/billing, any
HTTP server at all.

## Layout

```
/opt/vendo5/
  main.js                 # entrypoint
  package.json
  lib/
    config.js              # config loader/accessor
    gpio.js                 # sysfs GPIO wrapper
    logger.js               # JSON line logger
  config/                   # shipped defaults, copied to /mnt/wifi5/vendo5-config on first boot
    network.json
    vendo.json
    licensing.json
/etc/init.d/vendo5           # procd service script
/mnt/wifi5/vendo5-config/    # live config on the data partition (created at first boot if absent)
```

## Components

### `lib/config.js`
- `loadConfig(dir)` — reads every `*.json` file in `dir`, merges into one
  object keyed by filename stem (`network`, `vendo`, `licensing`), returns it.
- `getConfig()` — returns the last-loaded config (module-level cache);
  throws if `loadConfig` hasn't run yet.
- On first boot, if `/mnt/wifi5/vendo5-config/` is empty or missing, copies
  the shipped defaults from `/opt/vendo5/config/` before loading.
- Validation: each config file declares the required top-level keys it
  must have; missing keys throw a startup error naming the file and key
  (fail loud, don't start half-configured).

### `lib/gpio.js`
- `exportPin(pin)` / `unexportPin(pin)` — writes to
  `/sys/class/gpio/export` / `unexport`.
- `readPin(pin)` — reads `/sys/class/gpio/gpio<N>/value`.
- `watchPin(pin, direction, edge, callback)` — sets `direction`/`edge` files,
  then uses `fs.watch` on the `value` file to invoke `callback(value)` on
  change. Returns a `stop()` function that unwatches and unexports.
- shortcut: sysfs polling via fs.watch has a few ms more latency than a
  native epoll addon; fine for coin-pulse debounce (pulses are tens of ms
  wide), revisit only if sub-project #2's hardware testing shows missed
  pulses.

### `lib/logger.js`
- `log(level, message, fields)` — writes one JSON line to stdout:
  `{ts, level, message, ...fields}`. Levels: `debug`, `info`, `warn`, `error`.
- No file logging here — procd/syslog capture stdout; keeps the module
  dependency-free.

### `main.js`
- Loads config, logs a startup line with version and config summary.
- Installs `SIGTERM`/`SIGINT` handlers that log a shutdown line and exit 0.
- Nothing else runs yet — later sub-projects hook into this entrypoint.

### `/etc/init.d/vendo5`
- Standard procd pattern copied from the existing `/etc/init.d/soft` style
  already on this device: `USE_PROCD=1`, `procd_open_instance`,
  `procd_set_param command /usr/bin/node /opt/vendo5/main.js`,
  `procd_set_param respawn`, stdout/stderr left to procd's default capture
  (not redirected to `/dev/null` like the original — we want the logs).

## Data flow

```
boot → procd starts vendo5 → main.js
  → config.loadConfig('/mnt/wifi5/vendo5-config')
      (copies defaults from /opt/vendo5/config/ if target dir empty)
  → logger.log('info', 'vendo5 started', {version, pins: [...]})
  → (idle; later sub-projects attach their own modules here)
SIGTERM → logger.log('info', 'vendo5 stopping') → exit 0
```

## Error handling

- Missing/invalid config key: throw synchronously at startup, procd sees
  non-zero exit, respawn backs off per procd's normal behavior, error is
  visible in the log line before exit.
- GPIO sysfs path missing (wrong board/pin, permissions): `exportPin`
  rejects with a descriptive error including the pin number and the sysfs
  path attempted; caller decides whether that's fatal.
- `fs.watch` failure (e.g. pin unexported externally): `watchPin`'s
  callback receives an `error` event; module logs and calls `stop()` to
  avoid a dangling watcher.

## Testing

No hardware required for this sub-project's automated check:
- `config.js`: unit test with a temp directory of fixture JSON files —
  happy path, missing required key, missing directory (defaults copied).
- `gpio.js`: unit test against a temp directory standing in for
  `/sys/class/gpio` (inject the base path) — export/read/watch against
  fake sysfs files, since real GPIO requires hardware.
- `main.js`: smoke test — spawn it as a child process with a fixture
  config dir, confirm it logs a startup line and exits 0 on SIGTERM.
- Real-hardware GPIO behavior (pulse timing, debounce under load) is
  deferred to sub-project #2, where it's actually exercised; this
  sub-project only proves the wrapper talks to sysfs correctly.

## Open questions for review

None — this sub-project's scope is intentionally narrow and has no
remaining ambiguity. Config schema details for `vendo.json`/`licensing.json`
(beyond "the file exists and loads") belong to sub-projects #2 and #6.
