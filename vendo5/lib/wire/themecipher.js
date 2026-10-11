// The React portal theme (newTheme) names every socket event with a small position-dependent substitution cipher
// (its `enc`): letter c at position z becomes W[(P(c) + z) mod 36]. The first event is enc(session id).
const W = 'JKLMNOPQRSTUVWXYZ0123456789ABCDEFGHI';
const SINGLE = { 0: 'H', 1: 'P', 2: 'C', 3: '9', 4: '7', 5: 'O', 6: 'N', 7: '2', 8: 'V', 9: 'Z', A: 'J', B: 'T', C: 'Y', D: '8', E: '1', F: 'K', G: 'S', H: '3', I: 'E', J: '4', K: '6', L: 'Q', M: '0', N: 'W', O: 'U', P: 'D', Q: 'X', R: 'M', S: 'I', T: 'R', U: 'L', V: 'F', W: 'A', X: 'G', Y: '5', Z: 'B' };
const POS = Object.fromEntries(Object.entries(SINGLE).map(([c, out]) => [c, W.indexOf(out)])); // char -> P
const CHAR = Object.fromEntries(Object.entries(POS).map(([c, p]) => [p, c])); // P -> char

const enc = (s) => [...String(s).toUpperCase()].map((c, z) => (c in POS ? W[(POS[c] + z) % 36] : '?')).join('');
const dec = (s) => [...String(s)].map((c, z) => { const k = W.indexOf(c); return k < 0 ? '?' : CHAR[(k - z + 360) % 36] || '?'; }).join('');

module.exports = { enc, dec };
