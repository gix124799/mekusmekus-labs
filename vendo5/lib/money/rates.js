const { cleanData } = require('./limits');
// The coin rate table: { set: { type }, rate: [{ coin (pesos), minute (seconds, the page's name for it), show, vendoset }] }.
// vendoset is the session profile that denomination grants: { type, upload, download, validity, pauselimit, max_data_limit, notsametype }.
const SPEED = /^\d+(K|M|G|T)$/;

function emptyConfig() {
  return { set: { type: 0 }, rate: [] };
}

// Pesos -> milliseconds: the biggest denominations first (so 5 pesos can earn more than five 1-peso coins), the
// remainder at the smallest row's own rate; with no table, the flat pesos-per-minute fallback.
function timeForPesos(config, pesos, fallbackPesosPerMinute) {
  const rows = (config.rate || []).filter((r) => r.coin > 0 && r.minute > 0).sort((a, b) => b.coin - a.coin);
  if (!rows.length) return (pesos / fallbackPesosPerMinute) * 60000;
  let ms = 0;
  let rest = pesos;
  for (const r of rows) {
    if (r.coin <= rest) {
      const k = Math.floor(rest / r.coin);
      ms += k * r.minute * 1000;
      rest -= k * r.coin;
    }
  }
  if (rest > 0) {
    const small = rows[rows.length - 1];
    ms += (rest / small.coin) * small.minute * 1000;
  }
  return Math.round(ms);
}

// The profile of the largest denomination that fits `pesos` (or the smallest row), for a new session.
function profileFor(config, pesos) {
  const rows = (config.rate || []).filter((r) => r.coin > 0).sort((a, b) => b.coin - a.coin);
  const row = rows.find((r) => r.coin <= pesos) || rows[rows.length - 1];
  const v = (row && row.vendoset) || {};
  return {
    type: v.type === 'pausable' ? 'pausable' : 'consumable',
    upload: v.upload, download: v.download, max_data_limit: v.max_data_limit,
    pauselimit: v.type === 'pausable' ? v.pauselimit : undefined,
    validityHours: v.type === 'pausable' ? v.validity : undefined,
    notsametype: v.notsametype,
  };
}

// Validate one rate row from the form. Returns the cleaned row or { err }.
function cleanRow({ config, minute, coin }) {
  const c = Number(coin);
  const m = Number(minute);
  if (!(Number.isInteger(c) && c >= 1 && c <= 100000)) return { err: 'Invalid coin value' };
  if (!(m > 0 && m <= 86400 * 3650)) return { err: 'Invalid time' };
  const v = config && typeof config === 'object' ? config : {};
  const set = { type: v.type === 'pausable' ? 'pausable' : 'consumable' };
  if (v.upload !== undefined) { if (!SPEED.test(String(v.upload))) return { err: 'Invalid upload limit' }; set.upload = v.upload; }
  if (v.download !== undefined) { if (!SPEED.test(String(v.download))) return { err: 'Invalid download limit' }; set.download = v.download; }
  if (set.type === 'pausable') {
    if (Number(v.validity) > 0) set.validity = Number(v.validity);
    if (Number(v.pauselimit) > 0) set.pauselimit = Number(v.pauselimit);
  }
  if (cleanData(v.max_data_limit) !== undefined) set.max_data_limit = cleanData(v.max_data_limit);
  set.notsametype = Number(v.notsametype) === 1 ? 1 : 0;
  if (typeof v.discription === 'string') set.discription = v.discription.slice(0, 80);
  return { coin: c, minute: m, show: true, vendoset: set };
}

module.exports = { emptyConfig, timeForPesos, profileFor, cleanRow };
