// Sits between the coin pin and the coin handler. Pulses close together are one coin (a train); a train is
// only credited once it has ended and looks like a real coin. Piezo-lighter sparks and line noise show up as
// pulses closer than any acceptor makes, or as more pulses than the largest coin; a coin with no one waiting
// to pay is a pulse nobody asked for. Repeated suspicious coins lock the slot for a while.
const WINDOW_MS = 10 * 60000;
const STRIKES = 3;
const LOCK_MS = 5 * 60000;

function createCoinGuard({ onCoin, hasPayer, notify, log, onLock = () => {}, minGapMs = 20, trainGapMs = 300, maxPulses = 20, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let train = null; // { count, last, bad, timer }
  let strikes = [];
  let locked = false;

  function suspicious(reason) {
    const t = now();
    log(`Coin rejected: ${reason}`);
    strikes = strikes.filter((at) => t - at < WINDOW_MS).concat(t);
    if (strikes.length < STRIKES) return;
    strikes = [];
    locked = true;
    log('Coin slot locked for 5 minutes: possible tampering');
    notify('Coin slot locked', 'Several fake or unexpected coin pulses: possible tampering. The slot opens again in 5 minutes.');
    onLock(true);
    setTimer(() => {
      locked = false;
      log('Coin slot unlocked');
      notify('Coin slot unlocked', 'The coin slot accepts coins again.');
      onLock(false);
    }, LOCK_MS);
  }

  function endTrain() {
    const { count, bad } = train;
    train = null;
    if (bad) return suspicious(bad);
    if (count > maxPulses) return suspicious(`${count} pulses, more than the largest coin (${maxPulses})`);
    if (!hasPayer()) return suspicious('orphan pulse, no one pressed Insert Coin');
    onCoin(count);
  }

  function pulse() {
    if (locked) return;
    const t = now();
    if (train) {
      if (t - train.last < minGapMs) train.bad = `pulses ${t - train.last} ms apart, too fast for a coin (piezo or noise)`;
      train.count += 1;
      train.last = t;
      clearTimer(train.timer);
    } else {
      train = { count: 1, last: t, bad: null };
    }
    train.timer = setTimer(endTrain, trainGapMs);
  }

  return { pulse, isLocked: () => locked };
}

module.exports = { createCoinGuard };
