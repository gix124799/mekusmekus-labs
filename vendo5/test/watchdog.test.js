const test = require('node:test');
const assert = require('node:assert');
const { createWatchdog } = require('../lib/system/watchdog');

function rig({ online = true, lan = true, notifyThrows = false } = {}) {
  const st = { online, icmp: true, frozenAt: null, revoked: [], lan, t: 1000000, ran: [], notes: [], lines: [], allowed: [], frozen: 0, thawMacs: [], saves: 0 };
  const sessions = {
    freeze: (t) => { st.frozen++; st.frozenAt = t; return ['m1', 'm2']; },
    thaw: () => { const m = st.thawMacs; st.thawMacs = []; return m; },
  };
  const wd = createWatchdog({
    exec: async (argv) => {
      st.ran.push(argv.join(' '));
      if (argv[0] === 'ping' && !(st.online && st.icmp)) throw new Error('100% packet loss');
      if (argv[0] === 'wget' && !st.online) throw new Error('timed out');
      return '';
    },
    linkExists: () => st.lan,
    sessions,
    firewall: { allow: (m) => st.allowed.push(m), revoke: (m) => st.revoked.push(m) },
    notifications: { add: (n) => { if (notifyThrows) throw new Error('disk full'); st.notes.push(n.title); } },
    mainlog: { write: (c, x) => st.lines.push(x) },
    save: () => { st.saves++; },
    now: () => st.t,
  });
  const tick = async (ms = 30000) => { st.t += ms; await wd.tick(); };
  return { wd, st, tick };
}
const ifups = (st, i) => st.ran.filter((r) => r === `ifup ${i}`).length;

test('online: pings only, nothing frozen', async () => {
  const { st, tick, wd } = rig();
  await tick();
  assert.deepEqual(st.ran, ['ping -c 1 -W 2 1.1.1.1']);
  assert.equal(st.frozen, 0);
  assert.equal(wd.status().wanUp, true);
});

test('3 failed ticks in a row freeze time and restart wan; recovery thaws, re-allows and notifies', async () => {
  const { st, tick, wd } = rig({ online: false });
  await tick(); await tick();
  assert.equal(st.frozen, 0, 'two failures are not an outage yet');
  await tick();
  assert.equal(st.frozen, 1);
  assert.equal(ifups(st, 'wan'), 1);
  assert.ok(st.saves >= 1);
  assert.equal(wd.status().wanUp, false);
  await tick(); // still down, under 10 min: no new ifup
  assert.equal(ifups(st, 'wan'), 1);
  st.online = true;
  st.thawMacs = ['m1', 'm2'];
  await tick();
  assert.deepEqual(st.allowed, ['m1', 'm2']);
  assert.deepEqual(st.notes, ['Internet back']);
  assert.equal(wd.status().recoveries, 1);
  assert.equal(wd.status().outageSince, null);
});

test('a long outage retries wan every 10 min and notifies once', async () => {
  const { st, tick } = rig({ online: false });
  await tick(); await tick(); await tick();
  for (let i = 0; i < 20; i++) await tick(60000); // 20 more minutes
  assert.equal(ifups(st, 'wan'), 3);
  assert.deepEqual(st.notes, ['Internet down']);
});

test('flapping WAN never freezes anyone', async () => {
  const { st, tick } = rig();
  for (let i = 0; i < 10; i++) { st.online = i % 2 === 0; await tick(); }
  assert.equal(st.frozen, 0);
});

test('first good ping after a restart thaws sessions left frozen on disk', async () => {
  const { st, tick } = rig();
  st.thawMacs = ['m9'];
  await tick();
  assert.deepEqual(st.allowed, ['m9']);
  assert.deepEqual(st.notes, [], 'no outage seen by this run, so no notification');
  assert.ok(st.lines.some((l) => /restart/.test(l)));
});

test('br-lan missing: netdetect then ifup lan, notify once, retry after 5 min', async () => {
  const { st, tick } = rig({ lan: false });
  await tick();
  assert.deepEqual(st.ran.slice(0, 2), ['/etc/vendo5-netdetect.sh', 'ifup lan']);
  await tick(); // 30 s later: no retry yet
  assert.equal(ifups(st, 'lan'), 1);
  await tick(5 * 60000);
  assert.equal(ifups(st, 'lan'), 2);
  assert.deepEqual(st.notes, ['LAN adapter missing']);
  st.lan = true;
  await tick();
  assert.ok(st.lines.some((l) => /LAN is back/.test(l)));
});

test('overlapping ticks do not run twice', async () => {
  const { st, wd } = rig();
  await Promise.all([wd.tick(), wd.tick()]);
  assert.equal(st.ran.length, 1);
});

test('a failing notification store does not stop freeze or thaw', async () => {
  const { st, tick } = rig({ online: false, notifyThrows: true });
  await tick(); await tick(); await tick();
  st.online = true;
  st.thawMacs = ['m1'];
  await tick();
  assert.equal(st.frozen, 1);
  assert.deepEqual(st.allowed, ['m1']);
});

test('ICMP blocked but the web works: not an outage, nobody frozen, no ifup', async () => {
  const { st, tick } = rig();
  st.icmp = false;
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(st.frozen, 0);
  assert.equal(ifups(st, 'wan'), 0);
});

test('freezing revokes the clients, so a wrong outage call never means free unmetered internet', async () => {
  const { st, tick } = rig({ online: false });
  await tick(); await tick(); await tick();
  assert.deepEqual(st.revoked, ['m1', 'm2']);
});

test('time is frozen from the first failed check, not the third', async () => {
  const { st, tick } = rig({ online: false });
  await tick();
  const firstFail = st.t;
  await tick(); await tick();
  assert.equal(st.frozenAt, firstFail);
});
