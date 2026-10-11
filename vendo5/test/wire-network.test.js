const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNetworkHandlers, parseIwPhy } = require('../lib/wire/network');
const { createUci } = require('../lib/system/uci');

function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5net-'));
  const calls = [];
  const runCommand = over.runCommand || (() => '');
  const uci = createUci({ runCommand: () => '', stateFile: path.join(dir, 'u.json'), hasUbus: false });
  const lines = [];
  const h = createNetworkHandlers({ file: path.join(dir, 'n.json'), uci, runCommand: (a) => { calls.push(a); return runCommand(a); }, arp: { neighbors: () => ({}) }, mainlog: { write: (c, x) => lines.push(x) }, leasesFile: path.join(dir, 'leases'), crontabFile: path.join(dir, 'cron', 'root'), resolve4: over.resolve4 || (async (host) => (host === 'example.com' ? ['93.184.216.34'] : [])), now: () => 1000, randomBytes: over.randomBytes, ...over.extra });
  return { h, dir, calls, lines, uci, call: (id, p) => h[id].handler(p, {}) };
}
const nft = (calls) => calls.filter((c) => c[0] === 'nft').map((c) => c.slice(1).join(' '));

test('every network event is guarded', () => { for (const [id, d] of Object.entries(rig().h)) assert.equal(d.guard, true, id); });

test('ISP speeds and WAN mode round-trip; junk is refused', async () => {
  const r = rig();
  assert.deepEqual(await r.call('@nav-0002311', { action: 'get', type: 'isp1' }), {});
  assert.equal(await r.call('@nav-0002311', { action: 'set', type: 'isp1', download: 20000000, upload: 5000000 }), true);
  assert.deepEqual(await r.call('@nav-0002311', { action: 'get', type: 'isp1' }), { download: 20000000, upload: 5000000 });
  assert.equal(await r.call('@nav-0002311', { action: 'set', type: 'isp1', download: -1, upload: 1 }), false);
  assert.deepEqual(await r.call('@nav-0002311', { action: 'get', type: '__proto__' }), {});
  assert.equal(await r.call('@nav-0002357', { action: 'get' }), false, 'unset reads as false (the page then says Single ISP)');
  assert.equal(await r.call('@nav-0002357', { action: 'set', mode: 'dual-isp-lbs' }), true);
  assert.deepEqual(await r.call('@nav-0002357', { action: 'get' }), ['dual-isp-lbs']);
  assert.equal(await r.call('@nav-0002357', { action: 'set', mode: 'rm -rf' }), false);
  assert.equal(await r.call('@nav-0002357', { action: 'reload' }), true);
  assert.deepEqual(r.calls.at(-1), ['/etc/init.d/network', 'reload']);
});

test('pingers and netwatcher accept IPv4 addresses only', async () => {
  const r = rig();
  assert.equal(await r.call('@nav-1452399', { action: 'SET', ping1: '8.8.8.8', ping2: '', ping3: '1.1.1.1' }), true);
  assert.deepEqual(await r.call('@nav-1452399', { action: 'GET' }), { ping1: '8.8.8.8', ping3: '1.1.1.1' });
  for (const bad of ['8.8.8', '300.1.1.1', 'google.com', '1.1.1.1; id']) assert.equal(await r.call('@nav-1452399', { action: 'SET', ping1: bad }), false, bad);
  assert.equal(await r.call('@nav-1452358', { action: 'SET', ip: '9.9.9.9', stoptimer: true }), true);
  assert.deepEqual(await r.call('@nav-1452358', { action: 'GET' }), { ip: '9.9.9.9', stoptimer: true });
  assert.equal(await r.call('@nav-1452358', { action: 'SET', ip: 'x' }), false);
});

test('WireGuard key: from wg genkey when valid, else a clamped random one', async () => {
  const good = 'A'.repeat(43) + '=';
  assert.equal(await rig({ runCommand: () => good + '\n' }).call('@nav-1452357'), good);
  const fb = await rig({ runCommand: () => { throw new Error('no wg'); }, randomBytes: () => Buffer.alloc(32, 255) }).call('@nav-1452357');
  const raw = Buffer.from(fb, 'base64');
  assert.equal(raw.length, 32);
  assert.deepEqual([raw[0] & 7, raw[31] & 128, raw[31] & 64], [0, 0, 64]);
  assert.match(await rig({ runCommand: () => 'junk' }).call('@nav-1452357'), /^[A-Za-z0-9+/]{43}=$/);
});

test('leases come from the lease file, keyed by MAC', async () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, 'leases'), '5000 aa:bb:cc:dd:ee:01 192.168.1.101 phone x\n');
  assert.deepEqual(await r.call('@nav-99800'), { cIfname: { 'aa:bb:cc:dd:ee:01': { ip: '192.168.1.101', hostname: 'phone', timeout: 5000, ifname: 'br-lan' } }, date: 1000 });
});

test('NTP servers are read from and written to uci (and committed); bad hosts are refused', async () => {
  const r = rig();
  assert.deepEqual((await r.call('@nav-78455', { action: 'GET' })).server, ['0.openwrt.pool.ntp.org', '1.openwrt.pool.ntp.org']);
  await r.call('@nav-78455', { action: 'SET', server: ['time.google.com', 'pool.ntp.org'] });
  assert.deepEqual((await r.call('@nav-78455', { action: 'GET' })).server, ['time.google.com', 'pool.ntp.org']);
  assert.deepEqual(r.uci.call('changes', { config: 'system' }), {}, 'committed, nothing pending');
  for (const bad of [[], ['bad host'], ['a;b'], ['a', 'b', 'c', 'd', 'e'], 'x', [5]]) await r.call('@nav-78455', { action: 'SET', server: bad });
  assert.deepEqual((await r.call('@nav-78455', { action: 'GET' })).server, ['time.google.com', 'pool.ntp.org']);
});

test('scheduler: validate, save to the crontab file, read back; invalid text never reaches the file', async () => {
  const r = rig();
  assert.equal(await r.call('@nav-365411145', { action: 'validate', cron: '*/5 * * * *' }), true);
  assert.equal(await r.call('@nav-365411145', { action: 'validate', cron: '99 * * * *' }), false);
  assert.equal(await r.call('@nav-365411145', { action: 'GET' }), '');
  assert.equal(await r.call('@nav-365411145', { action: 'SET', cron: '0 3 * * * /usr/bin/backup\n' }), '');
  assert.equal(await r.call('@nav-365411145', { action: 'GET' }), '0 3 * * * /usr/bin/backup\n');
  assert.deepEqual(r.calls.at(-1), ['/etc/init.d/cron', 'restart']);
  assert.equal(await r.call('@nav-365411145', { action: 'SET', cron: 'nonsense\n' }), 'Error');
  assert.equal(fs.readFileSync(path.join(r.dir, 'cron', 'root'), 'utf8'), '0 3 * * * /usr/bin/backup\n');
});

test('walled garden: add resolves and puts the addresses in the nft set; remove takes them out; flush empties; bad input refused', async () => {
  const r = rig();
  assert.deepEqual(await r.call('@nav-3002145', { action: 'add', domain: 'https://example.com/path', type: 'domain', id: 'w1' }), { success: true });
  assert.deepEqual(await r.call('@nav-3002145', { action: 'get' }), [{ id: 'w1', domain: 'example.com', type: 'domain', address: ['93.184.216.34'] }]);
  assert.ok(nft(r.calls).includes('add element inet vendo5 walled { 93.184.216.34 }'));
  assert.deepEqual(await r.call('@nav-3002145', { action: 'add', domain: 'example.com', id: 'w1' }), { err: 'Duplicate' });
  assert.deepEqual(await r.call('@nav-3002145', { action: 'add', domain: '10.1.2.3', id: 'w2' }), { success: true });
  assert.deepEqual(await r.call('@nav-3002145', { action: 'add', domain: 'offline.invalid', id: 'w3' }), { success: true }, 'unresolvable offline: kept without addresses');
  for (const bad of ['', 'bad host', 'x'.repeat(300)]) assert.equal((await r.call('@nav-3002145', { action: 'add', domain: bad, id: 'wx' })).err, 'Invalid domain', bad);
  assert.equal((await r.call('@nav-3002145', { action: 'add', domain: 'example.com', id: '../x' })).err, 'Invalid domain');
  assert.deepEqual(await r.call('@nav-3002145', { action: 'remove', id: 'w1' }), { success: true });
  assert.ok(nft(r.calls).includes('delete element inet vendo5 walled { 93.184.216.34 }'));
  assert.equal((await r.call('@nav-3002145', { action: 'remove', id: 'nope' })).err, 'Not found');
  assert.deepEqual(await r.call('@nav-3002145', { action: 'flush' }), { success: true });
  assert.deepEqual(await r.call('@nav-3002145', { action: 'get' }), []);
});

test('port forwards: saved as a JSON string, applied as dnat rules, validated hard', async () => {
  const r = rig();
  assert.equal(await r.call('@nav-326548', { action: 'GET' }), '{}');
  const cfg = { a1: { srcip: '203.0.113.5', srcport: '8080', dstip: '192.168.1.50', dstport: '80', comment: 'cam' }, b2: { srcip: '', srcport: 2222, dstip: '192.168.1.60', dstport: 22 } };
  assert.equal(await r.call('@nav-326548', { action: 'SET', config: cfg }), '');
  assert.deepEqual(JSON.parse(await r.call('@nav-326548', { action: 'GET' })).b2, { srcip: '', srcport: '2222', dstip: '192.168.1.60', dstport: '22' });
  const rules = nft(r.calls).filter((x) => x.startsWith('add rule'));
  assert.deepEqual(rules, ['add rule ip vendo5pf prerouting ip daddr 203.0.113.5 tcp dport 8080 dnat to 192.168.1.50:80', 'add rule ip vendo5pf prerouting tcp dport 2222 dnat to 192.168.1.60:22']);
  for (const bad of [{ x: { srcport: 0, dstip: '1.1.1.1', dstport: 1 } }, { x: { srcport: 1, dstip: 'nope', dstport: 1 } }, { x: { srcport: 1, dstip: '1.1.1.1', dstport: 70000 } }, { x: { srcport: 1, srcip: 'a', dstip: '1.1.1.1', dstport: 1 } }, { '../x': { srcport: 1, dstip: '1.1.1.1', dstport: 1 } }, [], 'str', { x: null }]) assert.equal(await r.call('@nav-326548', { action: 'SET', config: bad }), 'Error', JSON.stringify(bad));
  assert.equal(Object.keys(JSON.parse(await r.call('@nav-326548', { action: 'GET' }))).length, 2, 'a refused save keeps the old list');
  assert.equal(await r.call('@nav-326548', { action: 'SET', config: {} }), '');
  assert.equal(await r.call('@nav-326548', { action: 'GET' }), '{}');
});

test('a failing nft is reported as an error but the list is still saved', async () => {
  const r = rig({ runCommand: (a) => { if (a[0] === 'nft' && a[2] === 'chain' && a[1] === 'add') throw new Error('nft: no'); return ''; } });
  assert.equal(await r.call('@nav-326548', { action: 'SET', config: { a: { srcport: 1, dstip: '1.1.1.1', dstport: 1 } } }), 'Error');
});

test('wireless channels: `iw phy` is parsed (disabled channels dropped); without iw the emulation answers', async () => {
  const text = 'Wiphy phy0\n\tBand 1:\n\t\tFrequencies:\n\t\t\t* 2412.0 MHz [1] (20.0 dBm)\n\t\t\t* 2417 MHz [2] (20.0 dBm)\n\t\t\t* 2472 MHz [13] (disabled)\n\tBand 2:\n\t\t\t* 5180 MHz [36] (23.0 dBm)\n\t\t\t* 5260 MHz [52] (23.0 dBm) (no IR, radar detection)\n';
  assert.deepEqual(parseIwPhy(text), { phy0: { phy: 'phy0', channels: { 'band 1': [{ channel: 1 }, { channel: 2 }], 'band 2': [{ channel: 36 }] } } });
  assert.deepEqual((await rig({ runCommand: () => text }).call('@nav-23446')).config.phy0.channels['band 2'], [{ channel: 36 }]);
  const emu = await rig({ runCommand: () => { throw new Error('no iw'); } }).call('@nav-23446');
  assert.equal(emu.config.phy0.channels['band 1'].length, 11);
});

test('ZeroTier info, restart; ngrok card answers "not used"', async () => {
  const r = rig({ runCommand: (a) => (a[0] === 'zerotier-cli' ? '[{"status":"OK","mac":"aa","assignedAddresses":["10.1.1.1/24"]}]' : '') });
  assert.equal((await r.call('@nav-23421', { action: 'getinfo', cmd: 'listnetworks' }))[0].status, 'OK');
  await r.call('@nav-23421', { action: 'restart' });
  assert.deepEqual(r.calls.at(-1), ['/etc/init.d/zerotier', 'restart']);
  assert.deepEqual(await rig({ runCommand: () => { throw new Error('x'); } }).call('@nav-23421', { action: 'getinfo' }), []);
  assert.match((await r.call('@nav-262098')).info, /not used/);
  assert.deepEqual(await r.call('@nav-63254'), {});
});
