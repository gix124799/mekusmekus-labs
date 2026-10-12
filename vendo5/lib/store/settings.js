const { jsonFile } = require('./jsonfile');
const { emptyConfig } = require('../money/rates');

// Every setting the Settings page edits, in one file. defaults() builds the factory state; read() merges what is on
// disk over it, so a file from an older version (fewer keys) still yields a complete object.
function defaults({ deviceName, coinPin, relayPin = 11, relayPinActive = 1 }) {
  return {
    main: {
      name: deviceName, description: '', coinpin: coinPin, relaypin: relayPin, relaypinactive: relayPinActive, edge: 'rising', bill: '', billedge: 'falling',
      insertbtn: true, billmulti: 1, countdownMax: 15, coinsBlockerDelay: 1000, insertCoinType: 0, coinCorrector: [],
      pins: { insertled: '', powerled: '', relay: relayPin, incoin: coinPin, inbill: '', billmulti: 1 },
      config: emptyConfig(),
    },
    key: '', insertBanDuration: 3, insertBancount: 3,
    sub: {},
    pausable: { autopause: false, autolimit: false },
    trial: { default: { enable: false } },
    redirect: '', footer: '', idkey: '',
    portalTheme: { enable: true, script: '', set: '' },
    gameports: {},
    points: { spinwheel: { price: [], controller: [], display: [], token: 0 }, redeem: {}, vendo: [], voucher: [], credit: [] },
  };
}

function createSettings({ file, deviceName, coinPin, relayPin = 11, relayPinActive = 1 }) {
  const factory = () => defaults({ deviceName, coinPin, relayPin, relayPinActive });
  const store = jsonFile(file, factory);
  const base = factory;
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
