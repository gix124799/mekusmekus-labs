const { jsonFile } = require('./jsonfile');
const { emptyConfig } = require('../money/rates');

// Every setting the Settings page edits, in one file. defaults() builds the factory state; read() merges what is on
// disk over it, so a file from an older version (fewer keys) still yields a complete object.
function defaults({ deviceName, coinPin }) {
  return {
    main: {
      name: deviceName, description: '', coinpin: coinPin, relaypin: '', relaypinactive: 1, edge: 'rising', bill: '', billedge: 'falling',
      insertbtn: true, billmulti: 1, countdownMax: 15, coinsBlockerDelay: 1000, insertCoinType: 0, coinCorrector: [],
      pins: { insertled: '', powerled: '', relay: '', incoin: coinPin, inbill: '', billmulti: 1 },
      config: emptyConfig(),
    },
    key: '', insertBanDuration: 3, insertBancount: 3,
    pausable: { autopause: false, autolimit: false },
    trial: { default: { enable: false } },
    redirect: '', footer: '', idkey: '',
    gameports: {},
    points: { spinwheel: { price: [], controller: [], display: [], token: 0 }, redeem: {}, vendo: [], voucher: [], credit: [] },
  };
}

function createSettings({ file, deviceName, coinPin }) {
  const store = jsonFile(file, () => defaults({ deviceName, coinPin }));
  const base = () => defaults({ deviceName, coinPin });
  const merge = (a, b) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
    const out = Array.isArray(a) ? [...a] : { ...a };
    for (const k of Object.keys(b)) out[k] = a && typeof a === 'object' && !Array.isArray(a[k]) && a[k] && typeof a[k] === 'object' ? merge(a[k], b[k]) : b[k];
    return out;
  };
  const read = () => merge(base(), store.read());
  return {
    read,
    // change(fn): fn mutates a fresh copy; the result is written. Returns fn's return value.
    change(fn) {
      const s = read();
      const r = fn(s);
      store.write(s);
      return r;
    },
  };
}

module.exports = { createSettings, defaults };
