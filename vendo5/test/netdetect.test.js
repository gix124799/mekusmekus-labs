const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'etc-overlay', 'etc', 'vendo5-netdetect.sh');
const NFT = path.join(__dirname, '..', 'etc-overlay', 'etc', 'vendo5-firewall.nft');
const NETWORK = path.join(__dirname, '..', 'etc-overlay', 'etc', 'config', 'network');
const DHCP = path.join(__dirname, '..', 'etc-overlay', 'etc', 'config', 'dhcp');

// nics: { name: 'usb' | 'onboard' | 'wifi' | 'virtual' }; uci: starting config. Returns what the script did.
function run(nics, uci = { 'network.wan.device': 'eth0', 'network.br_lan.ports': 'eth1' }, nft = fs.readFileSync(NFT, 'utf8')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-'));
  const sys = path.join(dir, 'net');
  for (const [n, kind] of Object.entries(nics)) {
    const d = path.join(sys, n);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'type'), '1\n');
    if (kind === 'virtual') continue;
    const hw = path.join(dir, 'hw', kind === 'usb' ? 'soc/usb1/1-1/1-1:1.0' : 'soc/emac', n);
    fs.mkdirSync(hw, { recursive: true });
    fs.symlinkSync(hw, path.join(d, 'device'));
    if (kind === 'wifi') fs.mkdirSync(path.join(d, 'wireless'));
  }
  const log = path.join(dir, 'calls');
  const state = path.join(dir, 'uci.json');
  fs.writeFileSync(state, JSON.stringify(uci));
  const fakeUci = path.join(dir, 'uci');
  fs.writeFileSync(fakeUci, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2).filter((x) => x !== '-q'); const s = JSON.parse(fs.readFileSync('${state}'));
fs.appendFileSync('${log}', a.join(' ') + '\\n');
if (a[0] === 'get') { if (!(a[1] in s)) process.exit(1); console.log(s[a[1]]); }
else if (a[0] === 'set' || a[0] === 'add_list') { const [k, v] = a[1].split('='); s[k] = v; }
else if (a[0] === 'delete') delete s[a[1]];
fs.writeFileSync('${state}', JSON.stringify(s));
`, { mode: 0o755 });
  const nftFile = path.join(dir, 'fw.nft');
  fs.writeFileSync(nftFile, nft);
  const reloads = path.join(dir, 'reloads');
  const r = spawnSync('sh', [SCRIPT], { env: { ...process.env, SYSNET: sys, UCI: fakeUci, NFT_FILE: nftFile, WAIT: '0', RELOAD: `echo r >> ${reloads}` }, encoding: 'utf8' });
  return {
    status: r.status, err: r.stderr, uci: JSON.parse(fs.readFileSync(state)), nft: fs.readFileSync(nftFile, 'utf8'),
    reloaded: fs.existsSync(reloads), commits: (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.startsWith('commit')).length,
  };
}
const wanOf = (nft) => /^define WAN = "(.+)"$/m.exec(nft)[1];

test('factory LAN is an untagged br-lan bridge at 10.0.0.1/19 with no VLAN devices', () => {
  const network = fs.readFileSync(NETWORK, 'utf8');
  assert.match(network, /config device 'br_lan'[\s\S]*?option name 'br-lan'/);
  assert.match(network, /config interface 'lan'[\s\S]*?option device 'br-lan'[\s\S]*?option ipaddr '10\.0\.0\.1'[\s\S]*?option netmask '255\.255\.224\.0'/);
  assert.doesNotMatch(network, /vlan/i);
  const dhcp = fs.readFileSync(DHCP, 'utf8');
  assert.match(dhcp, /config dhcp 'lan'[\s\S]*?option start '2'[\s\S]*?option limit '8190'/);
  assert.match(dhcp, /list dhcp_option '3,10\.0\.0\.1'/);
  assert.match(dhcp, /list dhcp_option '6,10\.0\.0\.1/);
});

test('unpaid clients get captive DNS (port 90, every name -> 10.0.0.1), HTTP to the portal, HTTPS dropped (no cert to show it over)', () => {
  const nft = fs.readFileSync(NFT, 'utf8');
  for (const r of [/udp dport 53 redirect to :90/, /tcp dport 53 redirect to :90/, /tcp dport 80 dnat ip to 10\.0\.0\.1:80/]) assert.match(nft, r);
  assert.doesNotMatch(nft, /tcp dport 443 dnat/);
  const dhcp = fs.readFileSync(DHCP, 'utf8');
  assert.match(dhcp, /config dnsmasq 'captive'[\s\S]*?option port '90'[\s\S]*?list address '\/#\/10\.0\.0\.1'/);
  assert.equal((dhcp.match(/option instance 'main'/g) || []).length, 2); // lan+wan DHCP stay on the main resolver only
});

test('the shipped firewall file names its WAN once and every rule follows it', () => {
  const nft = fs.readFileSync(NFT, 'utf8');
  assert.equal(wanOf(nft), 'eth0');
  assert.ok(!/oifname "eth0"/.test(nft), 'no rule may hard-code the WAN name');
  assert.equal((nft.match(/oifname \$WAN/g) || []).length, 3);
});

test('correct names: nothing is touched and nothing reloads', () => {
  const r = run({ lo: 'virtual', eth0: 'onboard', eth1: 'usb' });
  assert.equal(r.status, 0);
  assert.equal(r.reloaded, false);
  assert.equal(r.commits, 0);
  assert.equal(wanOf(r.nft), 'eth0');
});

test('the real names differ: UCI, the firewall define and a reload all follow them', () => {
  const r = run({ lo: 'virtual', end0: 'onboard', enx001122334455: 'usb' });
  assert.equal(r.uci['network.wan.device'], 'end0');
  assert.equal(r.uci['network.br_lan.ports'], 'enx001122334455');
  assert.equal(wanOf(r.nft), 'end0');
  assert.equal(r.commits, 1);
  assert.equal(r.reloaded, true);
});

test('swapped names are fixed too, and a second run is a no-op', () => {
  const first = run({ eth0: 'usb', eth1: 'onboard' });
  assert.equal(first.uci['network.wan.device'], 'eth1');
  assert.equal(first.uci['network.br_lan.ports'], 'eth0');
  const again = run({ eth0: 'usb', eth1: 'onboard' }, first.uci, first.nft);
  assert.equal(again.reloaded, false);
});

test('no USB adapter: config is left as it is (a guess beats breaking a working box)', () => {
  const r = run({ eth0: 'onboard' });
  assert.equal(r.reloaded, false);
  assert.equal(r.uci['network.br_lan.ports'], 'eth1');
  assert.match(r.err, /could not tell WAN from LAN/);
});

test('wifi, virtual and bridge devices are never picked as WAN or LAN', () => {
  const r = run({ lo: 'virtual', 'br-lan': 'virtual', wlan0: 'wifi', eth0: 'onboard', eth1: 'usb' });
  assert.equal(r.reloaded, false);
  assert.equal(r.uci['network.wan.device'], 'eth0');
});
