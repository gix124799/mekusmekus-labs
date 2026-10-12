const { timeForPesos } = require('../money/rates');
const { dataBytes } = require('../money/limits');

const asObj = (v) => (v && typeof v === 'object' ? v : {});
const KEYS = Array.from({ length: 46 }, (_, i) => `@portal-${i}`);
const K = (n) => KEYS[n];

const decode = (t) => String(t).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// The customer portal's events. The original page emits `keys[n]` for operation n; n is fixed by the page, the names
// are ours (the table goes to the page in the `wisft` global). Every handler answers for the device behind the socket.
function createPortalHandlers({ sessions, money, ops, wallet, clients, settings, clientLog, chat, push, media, vouchers, sales, arp, listenCoin, stopCoin = () => {}, version, now = Date.now, ratePesosPerMinute, mainlog, vendoOf = () => 'main' }) {
  const guarded = (fallback, handler) => ({ fallback, handler });
  const cfg = () => settings.read();
  const noDevice = 'Device not recognised';

  const ipOf = (mac) => { try { const n = arp.neighbors()[mac]; return n ? n.ip : ''; } catch { return ''; } };

  function info(mac, ctx) {
    const t = now();
    const s = mac ? sessions.getSession(mac) : null;
    const c = mac ? clients.all()[mac] || {} : {};
    const live = !!s && (s.paused || s.expiresAt > t);
    const out = {
      internet: true, interface: 'br-lan', id: mac || '', mac: mac || '', address: (mac && ipOf(mac)) || ctx.ip || '', credit: c.credit || 0, point: c.point || 0,
      status: !live ? 'Disconnected' : s.paused ? 'Paused' : s.disconnected ? 'Disconnected' : 'Connected', now: t, trial: false, lastinsertedvendo: 'main', max_data_limit: dataBytes(s && s.max_data_limit), start_date: (s && s.startedAt) || 0, total_download_data: (s && s.usedDown) || 0, total_upload_data: (s && s.usedUp) || 0,
      ulimit: (s && s.upload) || '', dlimit: (s && s.download) || '', RXRate: 0, TXRate: 0, upload: 0, download: 0, code: (s && (s.code || s.resumeCode)) || '', resduration: '00:00:00',
    };
    out.validity = 0;
    if (live) {
      out.type = s.type || 'consumable';
      out.duration = Math.max(0, Math.round(((s.paused ? s.remainingMs : s.expiresAt - t)) / 1000));
      out.expiration = s.paused ? t + s.remainingMs : s.expiresAt;
      out.uptime = Math.max(0, Math.round((t - (s.startedAt || t)) / 1000));
      if (s.validityEnd) out.validity = s.validityEnd;
      if (s.pauselimit !== undefined) out.pauselimit = s.pauselimit;
    }
    return out;
  }

  const rateCfg = () => cfg().main.config;

  return {
    // Logs page; while the device has time it ends with the code that takes the time to a new MAC.
    [K(0)]: guarded('', (_p, ctx) => {
      if (!ctx.mac) return '';
      const logs = clientLog.read(ctx.mac).data;
      const s = sessions.getSession(ctx.mac);
      const live = !!s && (s.paused || s.expiresAt > now());
      return live && s.resumeCode ? `${logs}Resume code: ${s.resumeCode} - if your phone changes its MAC, enter this code in the voucher box to get your time back\n` : logs;
    }),
    [K(2)]: guarded({}, (_p, ctx) => info(ctx.mac, ctx)),

    [K(3)]: guarded('Error', (_p, ctx) => {
      if (!ctx.mac) return noDevice;
      const t = cfg().trial.default || {};
      return t.enable ? ops.trial(ctx.mac, t) : 'Free trial is not available';
    }),

    // Pause / disconnect (the same button), and the two ways back
    [K(4)]: guarded('Error', (_p, ctx) => {
      if (!ctx.mac) return noDevice;
      const s = sessions.getSession(ctx.mac);
      if (s && s.paused) { const r = money.resume(ctx.mac); return r.ok ? 'Connected' : r.message; }
      if (s && s.type === 'pausable') { const r = money.pause(ctx.mac); return r.ok ? 'Paused' : r.message; }
      const r = ops.disconnect(ctx.mac);
      return r.ok ? 'Disconnected' : r.message;
    }),
    [K(5)]: guarded('Error', (_p, ctx) => { const r = ops.connectBack(ctx.mac); return r.ok ? 'Connected' : `Error: ${r.message}`; }),
    [K(6)]: guarded('Error', (_p, ctx) => { const r = ops.connectBack(ctx.mac); return r.ok ? 'Connected' : `Error: ${r.message}`; }),

    // wallet pesos -> a voucher the client can hand to a friend
    [K(7)]: guarded({}, (amount, ctx) => {
      const a = Number(amount);
      if (!ctx.mac || !(a > 0)) return {};
      if (wallet.balance(ctx.mac) < a) return {};
      const ms = timeForPesos(rateCfg(), a, ratePesosPerMinute());
      const r = vouchers.generate({ type: '0', qty: 1, length: 8, random: true, prefix: 'W', upload: '10M', download: '10M', duration: Math.round(ms / 1000), owner: 'Client', price: a, notsametype: 0 });
      if (r.message !== 'Done') return {};
      wallet.add(ctx.mac, -a);
      return { code: r.newvoucher[0].code };
    }),

    [K(8)]: guarded('Error', (code, ctx) => ops.redeemCreditToWallet(ctx.mac, code)),
    [K(9)]: guarded('Error', (code, ctx) => { const r = money.redeemVoucher(ctx.mac, code); return r.ok ? 'Connected' : r.message; }),
    [K(10)]: guarded('Error', (code, ctx) => { const r = money.redeemVoucher(ctx.mac, code); return r.ok ? 'Success' : r.message; }),
    [K(11)]: guarded('Error', (pesos, ctx) => { const r = wallet.connect(ctx.mac, Number(pesos)); return r.ok ? 'Success' : r.message; }),
    [K(12)]: guarded('Error', (pesos, ctx) => { const r = wallet.connect(ctx.mac, Number(pesos)); return r.ok ? r.message : r.message === 'Insufficient Credit' ? 'Insuffient Credit. Please insert coin.' : r.message; }),

    // Insert coin: the device becomes the pending payer; coins then fill its wallet (pushes 20/21 tell the page)
    [K(13)]: guarded({ message: 'Error' }, (p, ctx) => {
      if (!ctx.mac) return { message: noDevice };
      // the popup's Close button sends type 0
      if (asObj(p).type === 0) { stopCoin(ctx.mac); return { message: 'Closed', countdown: 0 }; }
      const r = listenCoin(ctx.mac, ctx.socket);
      if (!r.ok) return { message: r.message };
      const s = sessions.getSession(ctx.mac);
      return { message: s && s.paused ? 'Resume' : 'Insert', rate: { rates: rateCfg().rate, type: rateCfg().set.type, rtype: rateCfg().set.type }, countdown: r.countdown, countdownMax: cfg().main.countdownMax, expiry: r.expiry, credit: wallet.balance(ctx.mac), incoin: 0 };
    }),
    [K(14)]: guarded({ vendoList: {} }, (_p, ctx) => {
      const id = vendoOf(ctx.mac);
      const s = cfg();
      const v = id === 'main' ? s.main : (s.sub || {})[id];
      if (!v) return { vendoList: {}, lastinsertedvendo: 'main' };
      return { vendoList: { [id]: { id, name: v.name, insertbtn: s.main.insertbtn, countdownMax: v.countdownMax } }, lastinsertedvendo: id };
    }),
    [K(15)]: guarded({ rates: [] }, () => ({ rates: rateCfg().rate.filter((r) => r.show !== false), type: rateCfg().set.type, lastinsertedvendo: 'main' })),
    [K(17)]: guarded([], () => ['main']),
    [K(18)]: guarded({ rates: [], rtype: 0 }, () => ({ rates: rateCfg().rate, rtype: rateCfg().set.type })),

    [K(19)]: guarded({}, () => { const d = media.disks().partition[0]; return d ? { [d.name]: media.list(d.mountpoint) || {} } : {}; }),

    // Chat (the device's own conversation)
    [K(22)]: guarded(true, (_p, ctx) => (ctx.mac ? !chat.clientHasUnread(ctx.mac) : true)),
    [K(26)]: guarded(true, (_p, ctx) => ctx.mac && chat.markClientSeen(ctx.mac)),
    [K(27)]: guarded(undefined, () => undefined),
    [K(28)]: guarded(false, (smg, ctx) => !!ctx.mac && !!chat.send(ctx.mac, smg)),
    [K(29)]: guarded({}, (_p, ctx) => (ctx.mac ? chat.history(ctx.mac) : {})),

    [K(34)]: guarded('', (_p, ctx) => {
      if (!ctx.mac) return '';
      const c = clients.all()[ctx.mac] || {};
      return `Credit: ${(c.credit || 0).toFixed(2)}\nPoints: ${(c.point || 0).toFixed(2)}\nTotal: ${(c.total || 0).toFixed(2)}`;
    }),

    // Points: redeem items, and spending them
    [K(37)]: guarded({}, () => cfg().points.redeem),
    [K(38)]: guarded({ error: true, message: 'Error' }, (id, ctx) => ops.redeemPoints(ctx.mac, String(id))),

    [K(39)]: guarded(undefined, (p) => { const d = media.disks().partition[0]; const q = asObj(p); if (d && q.id && Number(q.time) > 0) media.watched(d.mountpoint, String(q.id), Number(q.time)); }),
    [K(40)]: guarded({}, () => ({ footer: cfg().footer, version })),

    // Spin wheel
    [K(41)]: guarded(null, () => {
      const w = cfg().points.spinwheel;
      if (!w.display.length) return null;
      return { options: { numSegments: w.display.length, segments: w.display.map((s) => ({ fillStyle: s.color, text: s.name, textFontSize: 16, textFillStyle: s.font || '#ffffff' })), animation: { type: 'spinToStop', duration: 5, spins: 8 } }, token: w.token };
    }),
    [K(42)]: guarded({ message: 'Error' }, (_p, ctx) => ops.spin(ctx.mac)),
    [K(43)]: guarded(false, () => cfg().points.spinwheel.display.length > 1),

    // the online services the original offered (buying load / duration with the vendor's wallet): not available
    [K(44)]: guarded({ status: 0, message: 'This feature is not available offline.' }, () => ({ status: 0, message: 'This feature is not available offline.' })),
    [K(45)]: guarded({ status: 'error', message: 'This feature is not available offline.' }, () => ({ status: 'error', message: 'This feature is not available offline.', balance: 0, products: [], rate: {}, rates: [], type: 0 })),
  };
}

module.exports = { createPortalHandlers, KEYS };
