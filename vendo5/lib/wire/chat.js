const asObj = (v) => (v && typeof v === 'object' ? v : {});

// The Chat page. These events are not @nav-* (the original named them @CHATAPP-*) but sit on the same admin socket.
// push(event, payload) sends to every logged-in admin socket (wired after the socket server exists).
function createChatHandlers({ chat, clients, online = () => new Set(), push = () => {}, mainlog }) {
  const log = (t) => mainlog.write('system', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });

  // The conversation row the admin sees, and what the admin socket is told after a change.
  const tellUnread = () => push('@CHATAPP-0001', chat.unread());

  return {
    '@CHATAPP-22114': guarded({}, () => {
      const names = clients.all();
      const on = online();
      const out = {};
      for (const [mac, v] of Object.entries(chat.list())) out[mac] = { ...v, name: (names[mac] && names[mac].name) || '', status: on.has(mac) ? 'online' : 'offline' };
      return out;
    }),
    '@CHATAPP-65478': guarded({}, () => chat.unread()),
    '@CHATAPP-23569': guarded({}, (p) => chat.history(asObj(p).mac)),
    '@CHATAPP-659873': guarded(false, (p) => { const ok = chat.markAdminSeen(asObj(p).mac); tellUnread(); return ok; }),
    '@CHATAPP-96996': guarded(false, (p) => {
      const r = chat.sendAdmin(asObj(p).mac, asObj(p).smg);
      if (!r) return false;
      push('@CHATAPP-456321', {});
      return true;
    }),
    '@CHATAPP-96955': guarded(false, (p) => {
      const smg = asObj(p).smg;
      let n = 0;
      for (const mac of Object.keys(clients.all())) if (chat.sendAdmin(mac, smg)) n++;
      if (n) { log(`Admin sent a message to ${n} client(s)`); push('@CHATAPP-456321', {}); }
      return n > 0;
    }),
    '@CHATAPP-234411': guarded(false, (p) => { const ok = chat.remove(asObj(p).mac); push('@CHATAPP-456321', {}); tellUnread(); return ok; }),
    // the admin is typing: nothing to store (the client side polls for messages)
    '@CHATAPP-98663': guarded(false, () => true),
    '@CHATAPP-89874GET': guarded({}, () => chat.getAuto()),
    '@CHATAPP-89874SAVE': guarded(false, (p) => { const ok = chat.setAuto(asObj(p)); if (ok) log('Admin saved the chat auto-reply'); return ok; }),
    '@nav-233202': guarded('Error', () => { const n = chat.removeAll(); log(`Admin cleared all chat (${n} conversation(s))`); tellUnread(); return 'Success'; }),
  };
}

// A client's message (the portal): stored, the admin told, and the auto-reply sent when it is due.
function clientSend({ chat, push }, mac, text) {
  const r = chat.sendClient(mac, { type: 'text', message: text });
  if (!r) return null;
  push('@CHATAPP-96578', { mac, msg: { [r.ts]: r.msg } });
  push('@CHATAPP-0001', chat.unread());
  const cfg = chat.getAuto();
  if (cfg.enable && cfg.message) {
    const hist = chat.history(mac);
    const lastAdmin = Math.max(0, ...Object.entries(hist).filter(([, m]) => m.sender === 'admin').map(([t]) => Number(t)));
    if (chat.now() - lastAdmin > cfg.interval * 60000) chat.sendAdmin(mac, { type: 'text', message: cfg.message.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'") });
  }
  return r;
}

module.exports = { createChatHandlers, clientSend };
