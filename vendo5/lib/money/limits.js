// Speed ("2M" = 2 megabit/s) and data-cap ("500M" = 500 megabytes; a plain number is megabytes) values from the forms.
const UNIT = { K: 1, M: 2, G: 3, T: 4 };
const SPEED = /^(\d+)(K|M|G|T)$/;

// bytes per second a speed string allows; 0 (or an unusable value) means unlimited
function speedBytesPerSec(v) {
  const m = SPEED.exec(String(v || ''));
  return m ? Number(m[1]) * 125 * 1000 ** (UNIT[m[2]] - 1) : 0;
}

// total bytes a data cap allows; 0 means no cap
function dataBytes(v) {
  if (typeof v === 'number' || /^\d+$/.test(String(v || ''))) return Number(v) > 0 ? Number(v) * 1024 ** 2 : 0;
  const m = SPEED.exec(String(v || ''));
  return m ? Number(m[1]) * 1024 ** UNIT[m[2]] : 0;
}

// what a form value becomes when stored: a positive number or a "500M" string, else undefined
function cleanData(v) {
  if (SPEED.test(String(v))) return String(v);
  return Number(v) > 0 ? Number(v) : undefined;
}

module.exports = { speedBytesPerSec, dataBytes, cleanData };
