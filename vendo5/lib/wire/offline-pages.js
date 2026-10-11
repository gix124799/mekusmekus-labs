const { jsonFile } = require('../store/jsonfile');

const asObj = (v) => (v && typeof v === 'object' ? v : {});
const OFFLINE = 'This feature uses an online service and is not available: this machine works offline.';
const fail = (message = OFFLINE) => ({ data: { status: 0, message } });

// Online Payment (@nav-23411) and Phone Rental (@nav-332654789): both were services of the vendor's cloud (a payment
// account; Android phones paired through it). Their pages open with the same layout, keep what the owner configures,
// show empty lists, and answer anything that needs the service with a plain "not available offline".
function createOfflinePageHandlers({ file, mainlog }) {
  const store = jsonFile(file, () => ({ payment: { apiKey: '', rate: 0, bypass: false }, rental: { insertBanDuration: 3, insertBancount: 3, rates: [] } }));
  const read = () => { const v = store.read(); return { payment: { apiKey: '', rate: 0, bypass: false, ...v.payment }, rental: { insertBanDuration: 3, insertBancount: 3, rates: [], ...v.rental } }; };
  const change = (fn) => { const s = read(); const r = fn(s); store.write(s); return r; };
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });
  const log = (t) => mainlog.write('system', t);

  return {
    '@nav-23411': guarded(fail('Error'), (payload) => {
      const p = asObj(payload);
      const c = read().payment;
      if (p.getConfig || p.getRate) return { apiKey: c.apiKey, rate: c.rate, bypass: c.bypass, rates: [], data: undefined };
      if (p.getBalance) return { data: { status: 1 }, balance: 0 };
      if (p.getAPIkey) return fail();
      if (p.createAPI) return fail();
      if (p.setAPIkey !== undefined) {
        const key = p.setAPIkey === 'disable' ? '' : String(p.setAPIkey);
        if (key.length > 120 || /\s/.test(key)) return 'Error';
        change((s) => { s.payment.apiKey = key; });
        log(`Admin ${key ? 'saved' : 'removed'} the online payment key`);
        return '';
      }
      if (p.setRate) { if (!(Number(p.rate) >= 0 && Number(p.rate) < 1000)) return 'Error'; change((s) => { s.payment.rate = Number(p.rate); }); return ''; }
      if (p.setBypass) { change((s) => { s.payment.bypass = p.bypass === true; }); return ''; }
      if (p.payoutprice || p.request || p.otp) return fail();
      if (p.Sales) return {};
      if (p.getPayoutLogs || p.getPPPoESaleLogs || p.getSaleLogs) return { data: { logs: [], total: 0, count: 0, recordsTotal: 0, recordsFiltered: 0 } };
      if (p.setTransaction) return '';
      return fail('Error');
    }),

    '@nav-332654789': guarded({}, (payload) => {
      const p = asObj(payload);
      const c = read().rental;
      switch (p.action) {
        case 'getLogsFile': return [];
        case 'readLogFile': return '';
        case 'remove_log': case 'remove_all_logs': return '';
        case 'get-users-loggedin': case 'get-users-data': return { info: {} };
        case 'getClient': return { info: {} };
        case 'getSales': return {};
        case 'clearSales': case 'removeSales': case 'clear_sales': case 'clear-users-sales': return '';
        case 'save-insertban': {
          if (!(Number.isInteger(p.insertBanDuration) && p.insertBanDuration >= 1) || !(Number.isInteger(p.insertBancount) && p.insertBancount >= 1)) return 'Error';
          change((s) => { s.rental.insertBanDuration = p.insertBanDuration; s.rental.insertBancount = p.insertBancount; });
          return '';
        }
        case 'logout-user': case 'set-users-duration': case 'remove-user': case 'set-users-name': case 'accept': case 'reject': case 'save-rate': case 'rename_id': case 'remove': case 'set_bandwidth': return 'Error';
        default: return c ? {} : {};
      }
    }),
  };
}

module.exports = { createOfflinePageHandlers };
