const test = require('node:test');
const assert = require('node:assert');
const { parseLeases, readLeases } = require('../lib/system/leases');
const { isValidCron, isValidCrontab } = require('../lib/system/cron');

test('leases: dnsmasq lines parse; junk, short and malformed lines are skipped; * means no hostname', () => {
  const t = '1791720000 AA:BB:CC:DD:EE:01 192.168.1.101 phone 01:aa\n1791720100 aa:bb:cc:dd:ee:02 192.168.1.102 * *\nnot a lease\n12 zz 1.1.1.1 x\n1791720000 aa:bb:cc:dd:ee:03 999 x\n';
  assert.deepEqual(parseLeases(t), [
    { timeout: 1791720000, mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.101', hostname: 'phone' },
    { timeout: 1791720100, mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.1.102', hostname: '' },
  ]);
});

test('readLeases: keyed by MAC, interface from the neighbour table, date is now', () => {
  const r = readLeases({ file: '/x', neighbors: () => ({ 'aa:bb:cc:dd:ee:01': { ip: '1', dev: 'wlan0' } }), now: () => 5, fsRead: () => '100 aa:bb:cc:dd:ee:01 10.0.0.5 phone x\n200 aa:bb:cc:dd:ee:02 10.0.0.6 * x\n' });
  assert.deepEqual(r, { cIfname: { 'aa:bb:cc:dd:ee:01': { ip: '10.0.0.5', hostname: 'phone', timeout: 100, ifname: 'wlan0' }, 'aa:bb:cc:dd:ee:02': { ip: '10.0.0.6', hostname: '', timeout: 200, ifname: 'br-lan' } }, date: 5 });
  assert.deepEqual(readLeases({ file: '/x', neighbors: () => ({}), now: () => 1, fsRead: () => { throw new Error('ENOENT'); } }), { cIfname: {}, date: 1 });
});

test('cron: valid specs pass, bad bounds / counts / syntax fail', () => {
  for (const ok of ['* * * * *', '*/5 0-6 1,15 * 1-5', '0 3 * * 0', '59 23 31 12 7']) assert.equal(isValidCron(ok), true, ok);
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-3 * * * *', 'a * * * *', '* * * * * *', '1-70 * * * *']) assert.equal(isValidCron(bad), false, bad);
});

test('crontab text: comments and blank lines are fine, every other line needs a command', () => {
  assert.equal(isValidCrontab('# backup\n\n0 3 * * * /usr/bin/backup\n*/5 * * * * echo hi\n'), true);
  for (const bad of ['0 3 * * *\n', '99 3 * * * x\n', 'x'.repeat(9000), 5, null]) assert.equal(isValidCrontab(bad), false, String(bad).slice(0, 20));
});
