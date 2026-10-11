// Five time fields and a command. Accepts *, numbers, ranges, lists and steps, within each field's bounds.
const BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const part = /^(\*|\d+(-\d+)?)(\/\d+)?$/;

function validField(f, [lo, hi]) {
  return f.split(',').every((p) => {
    if (!part.test(p)) return false;
    const [range, step] = p.split('/');
    if (step !== undefined && !(Number(step) >= 1)) return false;
    if (range === '*') return true;
    const [a, b] = range.split('-').map(Number);
    return a >= lo && a <= hi && (b === undefined || (b >= a && b <= hi));
  });
}

// "m h dom mon dow" (the page validates just those five fields)
function isValidCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  return f.length === 5 && f.every((x, i) => validField(x, BOUNDS[i]));
}

// A crontab text is valid when every non-empty line is a valid time spec plus a command (comments allowed).
function isValidCrontab(text) {
  if (typeof text !== 'string' || text.length > 8000) return false;
  return text.split('\n').every((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return true;
    const f = t.split(/\s+/);
    return f.length >= 6 && isValidCron(f.slice(0, 5).join(' ')) && !/[\0\r]/.test(t);
  });
}

module.exports = { isValidCron, isValidCrontab };
