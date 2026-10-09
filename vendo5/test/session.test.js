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
