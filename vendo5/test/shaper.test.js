const test = require('node:test');
const assert = require('node:assert');
const { createShaper } = require('../lib/system/shaper');
const { speedBytesPerSec, dataBytes, cleanData } = require('../lib/money/limits');

const A = 'aa:bb:cc:dd:ee:01', B = 'aa:bb:cc:dd:ee:02';
const NOW = 1_000_000;

function rig(sess) {
  const files = [];
  const cmds = [];
  let counters = {}; // comment -> bytes, what `nft -j list chain` reports
  const store = { all: () => sess, getSession: (m) => sess[m] };
  const capped = [];
  const sh = createShaper({
    sessions: store, arp: { neighbors: () => ({ [A]: { ip: '10.0.0.5' } }) }, file: '/x/limits.nft', now: () => NOW,
    write: (f, t) => files.push(t), onCap: (m) => capped.push(m), save: () => {},
    runCommand: (args) => {
      cmds.push(args.join(' '));
      if (args[1] === '-j') return JSON.stringify({ nftables: Object.entries(counters).map(([comment, bytes]) => ({ rule: { comment, expr: [{ counter: { packets: 1, bytes } }] } })) });
      return '';
    },
  });
  return { sh, files, cmds, capped, setCounters: (c) => { counters = c; } };
}

test('limit values: speeds in megabit, data caps in bytes', () => {
  assert.equal(speedBytesPerSec('2M'), 250000);
  assert.equal(speedBytesPerSec('512K'), 64000);
  assert.equal(speedBytesPerSec('x'), 0);
  assert.equal(dataBytes('500M'), 500 * 1024 ** 2);
  assert.equal(dataBytes(10), 10 * 1024 ** 2);
  assert.equal(dataBytes(undefined), 0);
  assert.equal(cleanData('1G'), '1G');
  assert.equal(cleanData('5'), 5);
  assert.equal(cleanData('abc'), undefined);
});

test('the chain is rewritten as one nft transaction with a speed rule per direction, and not again when nothing changed', () => {
  const r = rig({ [A]: { expiresAt: NOW + 5000, upload: '1M', download: '2M' } });
  assert.equal(r.sh.tick(), true);
  const t = r.files[0];
  assert.match(t, /^add chain inet vendo5 bwlimit \{[^}]*\}\nflush chain inet vendo5 bwlimit\n/);
  assert.match(t, new RegExp(`ether saddr ${A} limit rate over 125000 bytes/second burst \\d+ bytes drop`));
  assert.match(t, /ip daddr 10\.0\.0\.5 limit rate over 250000 bytes\/second/);
  assert.match(t, new RegExp(`counter comment "v5u:${A}"`));
  assert.ok(r.cmds.includes('nft -f /x/limits.nft'));
  assert.equal(r.sh.tick(), false, 'same rules: no rewrite');
  assert.equal(r.files.length, 1);
});

test('paused, disconnected and expired sessions get no rules; a device without an IP gets only the upload side', () => {
  const r = rig({ [A]: { expiresAt: NOW + 5000, paused: true }, [B]: { expiresAt: NOW + 5000, upload: '1M', download: '1M' } });
  r.sh.tick();
  assert.ok(!r.files[0].includes(A));
  assert.match(r.files[0], new RegExp(`saddr ${B} limit`));
  assert.ok(!r.files[0].includes('ip daddr'), 'B has no known IP');
  const r2 = rig({ [A]: { expiresAt: NOW - 1 }, [B]: { expiresAt: NOW + 5000, disconnected: true } });
  r2.sh.tick();
  assert.match(r2.files[0], /flush chain inet vendo5 bwlimit\n$/);
});

test('usage is added once per byte (not again each tick), and a device over its data cap is ended', () => {
  const sess = { [A]: { expiresAt: NOW + 5000, upload: '1M', max_data_limit: 100 } };
  sess[A].max_data_limit = '1K'; // 1024 bytes
  const r = rig(sess);
  r.sh.tick();
  r.setCounters({ [`v5u:${A}`]: 400, [`v5d:${A}`]: 300 });
  r.sh.tick();
  assert.equal(sess[A].usedUp, 400);
  assert.equal(sess[A].usedDown, 300);
  assert.deepEqual(r.capped, []);
  r.sh.tick(); // same counter values: nothing added
  assert.equal(sess[A].usedUp, 400);
  r.setCounters({ [`v5u:${A}`]: 700 });
  r.sh.tick();
  assert.equal(sess[A].usedUp, 700);
  assert.equal(sess[A].usedUp + sess[A].usedDown, 1000);
  r.setCounters({ [`v5u:${A}`]: 800 });
  r.sh.tick();
  assert.deepEqual(r.capped, [A], '1100 bytes >= 1024');
});

test('a failing nft is logged and retried on the next tick', () => {
  const logs = [];
  let fail = true;
  const sh = createShaper({ sessions: { all: () => ({}), getSession: () => null }, arp: { neighbors: () => ({}) }, file: '/x', now: () => NOW, write: () => {}, log: (l, m) => logs.push(m),
    runCommand: (a) => { if (a[1] === '-f' && fail) throw new Error('nft: boom'); return ''; } });
  assert.equal(sh.tick(), false);
  fail = false;
  assert.equal(sh.tick(), true);
  assert.equal(logs.length, 1);
});
