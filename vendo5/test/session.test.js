const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore } = require('../lib/session');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5sess-')), 'sessions.json');

test('addCredit creates a new session with correct expiry', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  const now = 1000000;
  s.addCredit('aa:bb:cc:dd:ee:ff', 5, 1, now); // 5 pesos @ 1 peso/min = 5 min
  const sess = s.getSession('aa:bb:cc:dd:ee:ff');
  assert.equal(sess.creditPesos, 5);
  assert.equal(sess.expiresAt, now + 5 * 60000);
});

test('addCredit on an active session extends (top-up), does not queue', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  const now = 1000000;
  s.addCredit('m1', 2, 1, now); // +2 min -> expires now+120000
  s.addCredit('m1', 3, 1, now + 1000); // top-up +3 min while still active
  const sess = s.getSession('m1');
  assert.equal(sess.creditPesos, 5);
  assert.equal(sess.expiresAt, now + 120000 + 180000);
});

test('addCredit on an expired session starts fresh from now, not from old expiry', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('m1', 1, 1, 1000); // expires at 61000
  s.addCredit('m1', 2, 1, 70000); // well after expiry
  const sess = s.getSession('m1');
  assert.equal(sess.creditPesos, 2); // fresh credit, old credit not carried
  assert.equal(sess.expiresAt, 70000 + 120000);
});

test('isActive true before expiry, false at/after', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('m1', 1, 1, 0); // expires at 60000
  assert.equal(s.isActive('m1', 59999), true);
  assert.equal(s.isActive('m1', 60000), false);
  assert.equal(s.isActive('unknown-mac', 0), false);
});

test('expireDue returns and removes only sessions past expiry', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('expired', 1, 1, 0); // expires 60000
  s.addCredit('active', 10, 1, 0); // expires 600000
  const due = s.expireDue(60000);
  assert.deepEqual(due, ['expired']);
  assert.equal(s.getSession('expired'), undefined);
  assert.ok(s.getSession('active'));
});

test('save then load round-trips state', () => {
  const file = tmpFile();
  const s1 = createSessionStore(file);
  s1.load();
  s1.addCredit('m1', 5, 1, 1000);
  s1.save();

  const s2 = createSessionStore(file);
  s2.load(1000); // same reference "now" as the save, so this round-trip
  // check is isolated from the separately-tested wall-clock expiry filter
  const sess = s2.getSession('m1');
  assert.equal(sess.creditPesos, 5);
  assert.equal(sess.expiresAt, 1000 + 300000);
});

test('load drops already-expired sessions found on disk', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    dead: { mac: 'dead', creditPesos: 1, expiresAt: 100 },
    alive: { mac: 'alive', creditPesos: 1, expiresAt: Date.now() + 999999999999 },
  }));
  const s = createSessionStore(file);
  s.load(); // "now" defaults to Date.now(), far past 100
  assert.equal(s.getSession('dead'), undefined);
  assert.ok(s.getSession('alive'));
});

test('load with missing file starts empty, does not throw', () => {
  const s = createSessionStore(path.join(os.tmpdir(), 'v5sess-missing-' + process.pid, 'sessions.json'));
  assert.doesNotThrow(() => s.load());
  assert.equal(s.getSession('anything'), undefined);
});

test('load with corrupt file starts empty, does not throw', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const s = createSessionStore(file);
  assert.doesNotThrow(() => s.load());
  assert.equal(s.getSession('anything'), undefined);
});

// Fix (code review Important #7): vendo boxes lose power routinely; a
// truncate-then-write leaves a corrupt file on a power cut mid-write,
// silently emptying every paying customer's session on next boot. save()
// must write via a temp file + rename, which also means it tolerates (and
// cleans up) a stale .tmp left over from a previous aborted write.
test('save writes via temp file + rename, replacing any stale .tmp from a previous crash', () => {
  const file = tmpFile();
  fs.writeFileSync(file + '.tmp', 'stale garbage from a previous crash');
  const s = createSessionStore(file);
  s.load();
  s.addCredit('m1', 1, 1, 0);
  s.save();
  assert.ok(!fs.existsSync(file + '.tmp'), 'stale .tmp should be consumed by the rename, not left behind');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.m1.creditPesos, 1);
});

test('all() returns every active session keyed by mac', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('m1', 1, 1, 0);
  s.addCredit('m2', 1, 1, 0);
  const snapshot = s.all();
  assert.deepEqual(Object.keys(snapshot).sort(), ['m1', 'm2']);
});

test('revoke removes an existing session and returns true', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addCredit('m1', 5, 1, 1000);
  assert.equal(s.revoke('m1'), true);
  assert.equal(s.getSession('m1'), undefined);
});

test('revoke on an unknown mac returns false and is a no-op', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  assert.equal(s.revoke('never-existed'), false);
  assert.deepEqual(s.all(), {});
});

test('revoke does not call save() itself (caller\'s responsibility)', () => {
  const file = tmpFile();
  const s = createSessionStore(file);
  s.load();
  s.addCredit('m1', 5, 1, 1000);
  s.save(); // the one save we expect on disk
  const before = fs.readFileSync(file, 'utf8');
  s.revoke('m1'); // no save() call after this
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(before, after); // file unchanged -- revoke alone never touched disk
});

test('forced pause works on a consumable session and does not spend pauselimit', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addTime('m1', 60000, { type: 'consumable' }, 1000);
  assert.equal(s.pause('m1', 2000).ok, false, 'a customer cannot pause a consumable session');
  assert.equal(s.pause('m1', 2000, { force: true }).ok, true);
  assert.equal(s.getSession('m1').remainingMs, 59000);
  s.resume('m1', 5000);
  s.addTime('m2', 60000, { type: 'pausable', pauselimit: 1 }, 1000);
  s.pause('m2', 2000, { force: true });
  assert.equal(s.getSession('m2').pauselimit, 1);
});

test('freeze stops the clock of running sessions; thaw resumes only those', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addTime('run', 60000, {}, 0);
  s.addTime('mine', 60000, { type: 'pausable' }, 0);
  s.pause('mine', 10000); // customer pause before the outage: 50000 left
  assert.deepEqual(s.freeze(20000), ['run']);
  assert.deepEqual(s.freeze(21000), [], 'freezing twice changes nothing');
  assert.deepEqual(s.expireDue(500000), [], 'nobody runs out during an outage');
  s.addCredit('run', 1, 1, 30000); // a coin during the outage: +60000
  assert.deepEqual(s.thaw(600000), ['run']);
  assert.equal(s.getSession('run').expiresAt, 600000 + 40000 + 60000);
  assert.equal(s.getSession('run').outage, undefined);
  assert.equal(s.getSession('mine').paused, true, 'a customer pause stays paused');
  assert.equal(s.getSession('mine').remainingMs, 50000);
  assert.deepEqual(s.thaw(700000), [], 'thaw with nothing frozen is a no-op');
});

test('an outage-frozen session cannot be resumed by hand (no internet to use it on)', () => {
  const s = createSessionStore(tmpFile());
  s.load();
  s.addTime('m1', 60000, {}, 0);
  s.freeze(10000);
  const r = s.resume('m1', 20000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /No internet/);
  assert.equal(s.getSession('m1').paused, true);
  assert.deepEqual(s.thaw(30000), ['m1']);
  assert.equal(s.getSession('m1').expiresAt, 30000 + 50000);
});

test('frozen sessions survive a save and load', () => {
  const f = tmpFile();
  const a = createSessionStore(f);
  a.load();
  a.addTime('m1', 60000, {}, 0);
  a.freeze(10000);
  a.save();
  const b = createSessionStore(f);
  b.load(999999999);
  assert.deepEqual(b.thaw(1000000), ['m1']);
  assert.equal(b.getSession('m1').expiresAt, 1000000 + 50000);
});
