const test = require('node:test');
const assert = require('node:assert/strict');
const clientIp = require('../lib/client-ip');

test('uses the forwarded address only when the peer is the local proxy', () => {
  assert.equal(clientIp('::ffff:127.0.0.1', { 'x-real-ip': '10.0.0.8', 'x-forwarded-for': '10.0.0.9' }), '10.0.0.8');
  assert.equal(clientIp('::1', { 'x-forwarded-for': '10.0.0.9, 127.0.0.1' }), '10.0.0.9');
  assert.equal(clientIp('10.0.0.4', { 'x-real-ip': '10.0.0.8' }), '10.0.0.4');
});

test('normalizes IPv4-mapped IPv6 and falls back to the peer for empty forwarded headers', () => {
  assert.equal(clientIp('::ffff:10.0.0.4'), '10.0.0.4');
  assert.equal(clientIp('127.0.0.1', { 'x-real-ip': ' ' }), '127.0.0.1');
});
