const LOOPBACK = new Set(['127.0.0.1', '::1']);

function normalize(address) {
  return String(address || '').split(',')[0].trim().replace(/^::ffff:/, '');
}

function clientIp(peerAddress, headers = {}) {
  const peer = normalize(peerAddress);
  if (!LOOPBACK.has(peer)) return peer;
  return normalize(headers['x-real-ip'] || headers['x-forwarded-for']) || peer;
}

module.exports = clientIp;
