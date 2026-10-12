const test = require('node:test');
const assert = require('node:assert');
const { createSubvendoApi, signFor } = require('../lib/subvendo');

const KEY = 'ABCDEFGHIJKLMN';
function rig({ accepted = true, key = KEY } = {}) {
  const st = { credits: [], requests: [], seen: [], relay: false, n: 0, ifaces: [] };
  const sub = { id: 'sub1', chip: 'A1B2C3', iface: 'vlan10' };
  const vendos = {
    byChip: (chip) => (accepted && chip === 'A1B2C3' ? sub : null),
    request: (chip, info) => st.requests.push([chip, info.iface]),
    seen: (id, info) => st.seen.push([id, info.version, info.interface]),
    setIface: (id, iface) => st.ifaces.push([id, iface]),
  };
  const api = createSubvendoApi({ vendos, vendoKey: () => key, credit: (id, p, g) => st.credits.push([id, p, g]), relayOn: () => st.relay, newNonce: () => `n${++st.n}` });
  const send = (body, iface = 'vlan10') => api.handle({ ...body, sig: signFor(KEY, body) }, { iface, ip: '10.1.0.50', mac: 'aa:00:00:00:00:01' });
  const hello = (boot = 7) => send({ chip: 'A1B2C3', hello: true, boot, nonce: '', events: [], version: '1.0.0' });
  return { st, api, send, hello };
}

test('hello then polls: each reply gives the next nonce, coins are credited once', () => {
  const { st, send, hello } = rig();
  assert.deepEqual(hello(), { nonce: 'n1', relay: false, ack: 0 });
  st.relay = true;
  const ev = [{ id: 1, pulses: 5, minGapMs: 98 }];
  assert.deepEqual(send({ chip: 'A1B2C3', boot: 7, nonce: 'n1', events: ev }), { nonce: 'n2', relay: true, ack: 1 });
  assert.deepEqual(send({ chip: 'A1B2C3', boot: 7, nonce: 'n2', events: ev }), { nonce: 'n3', relay: true, ack: 1 }, 'resent after a lost reply: not credited again');
  assert.deepEqual(st.credits, [['sub1', 5, 98]]);
  assert.deepEqual(st.seen.at(-1), ['sub1', '', 'vlan10']);
});

test('a replayed request (old nonce) is refused and asks for a new hello', () => {
  const { st, send, hello } = rig();
  hello();
  const body = { chip: 'A1B2C3', boot: 7, nonce: 'n1', events: [{ id: 1, pulses: 1, minGapMs: null }] };
  send(body);
  assert.deepEqual(send(body), { error: 'stale', hello: true });
  assert.equal(st.credits.length, 1);
});

test('a replayed old hello does not reset what was already credited for that boot', () => {
  const { st, send, hello } = rig();
  hello(7);
  send({ chip: 'A1B2C3', boot: 7, nonce: 'n1', events: [{ id: 1, pulses: 1, minGapMs: null }] });
  hello(3); // an attacker replays an old hello
  hello(7); // the ESP says hello again for its own boot
  send({ chip: 'A1B2C3', boot: 7, nonce: 'n4', events: [{ id: 1, pulses: 1, minGapMs: null }, { id: 2, pulses: 5, minGapMs: 90 }] });
  assert.deepEqual(st.credits.map((c) => c[1]), [1, 5]);
});

test('bad signature, no vendo key, or a malformed body are refused', () => {
  const { api, st } = rig();
  const body = { chip: 'A1B2C3', hello: true, boot: 7, nonce: '', events: [] };
  assert.deepEqual(api.handle({ ...body, sig: 'f'.repeat(64) }, { iface: 'vlan10' }), { error: 'bad signature' });
  assert.deepEqual(api.handle({ ...body, chip: 'x y', sig: signFor(KEY, body) }, {}), { error: 'bad request' });
  assert.deepEqual(rig({ key: '' }).hello(), { error: 'vendo key not set' });
  assert.equal(st.credits.length, 0);
});

test('a chip that is not accepted shows up as a request and gets no coins credited', () => {
  const { st, send, hello } = rig({ accepted: false });
  assert.deepEqual(hello(), { nonce: 'n1', pending: true });
  send({ chip: 'A1B2C3', boot: 7, nonce: 'n1', events: [{ id: 1, pulses: 5, minGapMs: 90 }] });
  assert.deepEqual(st.requests, [['A1B2C3', 'vlan10'], ['A1B2C3', 'vlan10']]);
  assert.deepEqual(st.credits, []);
});

test('an accepted ESP moved to another VLAN updates its interface', () => {
  const { st, send } = rig();
  send({ chip: 'A1B2C3', hello: true, boot: 7, nonce: '', events: [] }, 'vlan20');
  assert.deepEqual(st.ifaces, [['sub1', 'vlan20']]);
});
