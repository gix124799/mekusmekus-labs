const test = require('node:test');
const assert = require('node:assert');
const { createCoinGuard } = require('../lib/coinguard');

// Fake clock and timers: advance(ms) runs every timer that falls due, in order.
function rig(opts = {}) {
  const st = { t: 1000000, timers: [], coins: [], lines: [], notes: [], relay: [], payer: true };
  const setTimer = (fn, ms) => { const h = { at: st.t + ms, fn }; st.timers.push(h); return h; };
  const clearTimer = (h) => { st.timers = st.timers.filter((x) => x !== h); };
  const guard = createCoinGuard({
    onCoin: (pulses) => st.coins.push(pulses),
    hasPayer: () => st.payer,
    notify: (title) => st.notes.push(title),
    log: (text) => st.lines.push(text),
    onLock: (locked) => st.relay.push(locked),
    now: () => st.t,
    setTimer,
    clearTimer,
    ...opts,
  });
  const advance = (ms) => {
    const end = st.t + ms;
    for (;;) {
      const due = st.timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      st.timers = st.timers.filter((x) => x !== due);
      st.t = due.at;
      due.fn();
    }
    st.t = end;
  };
  // a coin: n pulses `period` ms apart, then the train gap passes
  const coin = (n, period = 100) => {
    for (let i = 0; i < n; i++) { if (i) advance(period); guard.pulse(); }
    advance(400);
  };
  return { guard, st, advance, coin };
}

test('a 1, 5 and 10 peso coin each arrive as one train of pulses', () => {
  const { st, coin } = rig();
  coin(1); coin(5); coin(10);
  assert.deepEqual(st.coins, [1, 5, 10]);
  assert.deepEqual(st.lines, []);
});

test('nothing is credited until the train has ended', () => {
  const { st, guard, advance } = rig();
  guard.pulse(); advance(100); guard.pulse();
  assert.deepEqual(st.coins, []);
  advance(299);
  assert.deepEqual(st.coins, []);
  advance(1);
  assert.deepEqual(st.coins, [2]);
});

test('two coins inserted one after another are two trains', () => {
  const { st, guard, advance } = rig();
  guard.pulse(); advance(350); guard.pulse(); advance(400);
  assert.deepEqual(st.coins, [1, 1]);
});

test('a piezo burst (pulses closer than the minimum gap) rejects the whole train', () => {
  const { st, coin } = rig();
  coin(6, 3);
  assert.deepEqual(st.coins, []);
  assert.match(st.lines[0], /too fast/);
});

test('more pulses than the largest coin rejects the train', () => {
  const { st, coin } = rig();
  coin(21);
  assert.deepEqual(st.coins, []);
  assert.match(st.lines[0], /21 pulses/);
  coin(20);
  assert.deepEqual(st.coins, [20]);
});

test('a coin with no one waiting to pay is not credited and counts as suspicious', () => {
  const { st, coin } = rig();
  st.payer = false;
  coin(1);
  assert.deepEqual(st.coins, []);
  assert.match(st.lines[0], /no one pressed Insert Coin/);
});

test('3 suspicious coins in 10 minutes lock the slot for 5 minutes, then it opens again', () => {
  const { st, coin, guard, advance } = rig();
  coin(5, 2); advance(60000); coin(5, 2);
  assert.equal(guard.isLocked(), false);
  advance(60000); coin(5, 2);
  assert.equal(guard.isLocked(), true);
  assert.deepEqual(st.relay, [true]);
  assert.deepEqual(st.notes, ['Coin slot locked']);
  coin(1); // ignored while locked
  assert.deepEqual(st.coins, []);
  advance(5 * 60000);
  assert.equal(guard.isLocked(), false);
  assert.deepEqual(st.relay, [true, false]);
  assert.deepEqual(st.notes, ['Coin slot locked', 'Coin slot unlocked']);
  coin(1);
  assert.deepEqual(st.coins, [1]);
});

test('suspicious coins spread over more than 10 minutes never lock', () => {
  const { coin, guard, advance } = rig();
  for (let i = 0; i < 5; i++) { coin(5, 2); advance(6 * 60000); }
  assert.equal(guard.isLocked(), false);
});

test('limits come from the options (calibration for other coin acceptors)', () => {
  const { st, coin } = rig({ minGapMs: 2, trainGapMs: 100, maxPulses: 50 });
  coin(30, 5);
  assert.deepEqual(st.coins, [30]);
});
