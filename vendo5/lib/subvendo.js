const crypto = require('node:crypto');

// What a sub-vendo's ESP8266 and the main say to each other (POST /subvendo/poll, every 500 ms). Requests are
// signed with a per-chip key derived from the 14-character vendo key, and carry the nonce of the main's last
// reply, so nothing captured on the open WiFi can be replayed. Coin events count up per ESP boot; each is
// credited once even when resent after a lost reply.
const CHIP = /^[0-9A-F]{6,8}$/;
const MAX_BOOTS = 8;

const message = (b) => `${b.chip}|${b.nonce || ''}|${b.boot}|${JSON.stringify(b.events || [])}`;
function signFor(vendoKey, b) {
  const chipKey = crypto.createHmac('sha256', String(vendoKey)).update(String(b.chip)).digest();
  return crypto.createHmac('sha256', chipKey).update(message(b)).digest('hex');
}

function createSubvendoApi({ vendos, vendoKey, credit, relayOn, newNonce = () => crypto.randomBytes(12).toString('hex'), log = () => {} }) {
  const state = new Map(); // chip -> { nonce, boot, lastId, boots: Map(boot -> lastId) }

  function handle(b, { iface = '', ip = '', mac = '' } = {}) {
    const key = String(vendoKey() || '');
    if (key.length !== 14) return { error: 'vendo key not set' };
    const events = b.events === undefined ? [] : b.events;
    if (typeof b.chip !== 'string' || !CHIP.test(b.chip) || typeof b.sig !== 'string' || !Array.isArray(events) || events.length > 20 || !Number.isInteger(b.boot)) return { error: 'bad request' };
    const want = Buffer.from(signFor(key, b));
    const got = Buffer.from(b.sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      log(`Sub-vendo ${b.chip}: bad signature from ${ip}`);
      return { error: 'bad signature' };
    }

    let st = state.get(b.chip);
    if (b.hello) {
      const boots = st ? st.boots : new Map();
      if (st) boots.set(st.boot, st.lastId);
      st = { nonce: null, boot: b.boot, lastId: boots.get(b.boot) || 0, boots };
      while (boots.size > MAX_BOOTS) boots.delete(boots.keys().next().value);
      state.set(b.chip, st);
    } else if (!st || b.nonce !== st.nonce || b.boot !== st.boot) {
      return { error: 'stale', hello: true };
    }
    st.nonce = newNonce();

    const v = vendos.byChip(b.chip);
    if (!v) {
      vendos.request(b.chip, { mac, iface, ip });
      return { nonce: st.nonce, pending: true };
    }
    if (iface && v.iface !== iface) vendos.setIface(v.id, iface);
    vendos.seen(v.id, { version: String(b.version || ''), interface: iface });
    if (!b.hello) {
      for (const e of events) {
        if (!e || !Number.isInteger(e.id) || e.id <= st.lastId) continue;
        st.lastId = e.id;
        credit(v.id, e.pulses, e.minGapMs === null || e.minGapMs === undefined ? NaN : Number(e.minGapMs));
      }
    }
    return { nonce: st.nonce, relay: !!relayOn(v.id), ack: st.lastId };
  }

  return { handle };
}

module.exports = { createSubvendoApi, signFor };
