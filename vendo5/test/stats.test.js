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

test('stand-in interfaces are added only when missing, and their traffic is bursty, not one steady rate', () => {
  let t = 10000000;
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const run = () => '[{"ifname":"lo","stats64":{"rx":{"bytes":1},"tx":{"bytes":1}}}]';
  const s = createStats({ fs: files({}), runCommand: run, standIns: ['eth0', 'eth1'], now: () => t, random });
  const read = () => JSON.parse(s.snapshot().interfaceInfo).find((x) => x.ifname === 'eth0').stats64;
  assert.deepEqual(JSON.parse(s.snapshot().interfaceInfo).map((x) => x.ifname), ['lo', 'eth0', 'eth1']);
  let prev = read().rx.bytes;
  const deltas = [];
  for (let i = 0; i < 40; i++) { t += 1000; const b = read().rx.bytes; deltas.push(b - prev); prev = b; }
  assert.ok(deltas.every((d) => d > 0), 'counters only go up');
  const min = Math.min(...deltas);
  const max = Math.max(...deltas);
  assert.ok(max > min * 2, `the rate varies (min ${min}, max ${max}), so the graph is not a flat line`);
  assert.ok(read().tx.bytes > 0);
  const real = () => '[{"ifname":"eth1","stats64":{"rx":{"bytes":5},"tx":{"bytes":5}}}]';
  const kept = JSON.parse(createStats({ fs: files({}), runCommand: real, standIns: ['eth0', 'eth1'] }).snapshot().interfaceInfo);
  assert.equal(kept.filter((x) => x.ifname === 'eth1').length, 1, 'a real interface is never duplicated or replaced');
  assert.equal(createStats({ fs: files({}), runCommand: run }).snapshot().interfaceInfo, run(), 'no stand-ins by default');
});
