const nodeFs = require('node:fs');
const path = require('node:path');
const { log } = require('./logger');

// shortcut: fs.watch (inotify on sysfs) instead of a native epoll addon; a few ms more latency,
// fine for coin pulses tens of ms wide. Revisit only if sub-project #2 hardware tests miss pulses.
function createGpio(base = '/sys/class/gpio', fs = nodeFs) {
  const check = (pin) => {
    if (!Number.isInteger(pin) || pin < 0) throw new Error(`invalid pin: ${pin}`);
    return pin;
  };
  const write = (file, data, pin) => {
    try {
      fs.writeFileSync(file, String(data));
    } catch (e) {
      if (e.code === 'EBUSY') return; // already (un)exported
      throw new Error(`gpio pin ${pin}: write ${file} failed: ${e.message}`);
    }
  };
  const pinDir = (pin) => path.join(base, `gpio${pin}`);

  const exportPin = (pin) => write(path.join(base, 'export'), check(pin), pin);
  const unexportPin = (pin) => write(path.join(base, 'unexport'), check(pin), pin);
  const readPin = (pin) => {
    const file = path.join(pinDir(check(pin)), 'value');
    try {
      return Number(fs.readFileSync(file, 'utf8').trim());
    } catch (e) {
      throw new Error(`gpio pin ${pin}: read ${file} failed: ${e.message}`);
    }
  };

  function watchPin(pin, direction, edge, callback) {
    check(pin);
    const dir = pinDir(pin);
    write(path.join(dir, 'direction'), direction, pin);
    write(path.join(dir, 'edge'), edge, pin);
    let watcher = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (watcher) watcher.close();
      try { unexportPin(pin); } catch (e) { log('warn', e.message, { pin }); }
    };
    let last = null;
    try { last = readPin(pin); } catch { /* first event reads it */ }
    // one write to the value file raises several change events; a callback only for a real change of level
    watcher = fs.watch(path.join(dir, 'value'), () => {
      try { const v = readPin(pin); if (v === last) return; last = v; callback(v); } catch (e) { log('error', e.message, { pin }); }
    });
    watcher.on('error', (e) => { log('error', `gpio pin ${pin}: watch failed: ${e.message}`, { pin }); stop(); });
    return stop;
  }

  return { exportPin, unexportPin, readPin, watchPin };
}

module.exports = { createGpio };
