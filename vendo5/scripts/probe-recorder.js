// Runs in the page right after socket.io.js. Wraps every acknowledgement's reply in a Proxy that records
// each property the page reads (and whether it exists), and records any exception the page's callback throws.
window.__rec = {}; window.__errs = [];
(function () {
  var S = io.Socket.prototype, orig = S.onack, emit = S.emit;
  window.__emits = []; S.emit = function (ev) { window.__lastEv = ev; window.__emits.push(ev); return emit.apply(this, arguments); };
  function wrap(v, path) {
    if (!v || typeof v !== 'object') return v;
    return new Proxy(v, { get: function (t, k) {
      if (typeof k === 'string') window.__rec[path + '.' + k] = (k in t) ? 'ok' : 'MISSING';
      return wrap(t[k], path + '.' + String(k).replace(/^[0-9a-f:]{17}$/i, '<mac>').replace(/^\d+$/, '#'));
    } });
  }
  S.onack = function (packet) {
    var ack = this.acks[packet.id];
    if (typeof ack !== 'function') return orig.call(this, packet);
    var ev = window.__ackEv && window.__ackEv[packet.id];
    delete this.acks[packet.id];
    var data = packet.data.map(function (x) { return wrap(x, 'reply'); });
    try { ack.apply(this, data); } catch (e) { window.__errs.push('ACK THROW: ' + e.message + ' | ' + (e.stack || '').split('\n')[0]); }
  };
  addEventListener('error', function (e) { window.__errs.push(String(e.message) + ' @' + e.filename + ':' + e.lineno); });
})();
