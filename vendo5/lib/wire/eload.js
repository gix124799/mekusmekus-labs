const { jsonFile } = require('../store/jsonfile');

const asObj = (v) => (v && typeof v === 'object' ? v : {});
const NO_PROVIDER = 'No e-load provider is connected: this machine works offline, so load cannot be sent.';

// The product catalogue the page lists per network (1 Globe/TM, 2 Smart/TNT/Sun, 3 Cignal/GSAT, 4 DITO, 5 Games, 6 Others).
const CATALOG = [
  [1, 'GLOBE10', 'Globe Regular 10', 10], [1, 'GLOBE20', 'Globe Regular 20', 20], [1, 'GLOBE50', 'Globe Regular 50', 50], [1, 'GLOBE100', 'Globe Regular 100', 100],
  [2, 'SMART10', 'Smart Regular 10', 10], [2, 'SMART20', 'Smart Regular 20', 20], [2, 'SMART50', 'Smart Regular 50', 50], [2, 'SMART100', 'Smart Regular 100', 100],
  [3, 'GSAT100', 'GSAT Load 100', 100], [3, 'GSAT200', 'GSAT Load 200', 200],
  [4, 'DITO50', 'DITO Load 50', 50], [4, 'DITO100', 'DITO Load 100', 100],
  [5, 'GAMES50', 'Game Credits 50', 50], [5, 'GAMES100', 'Game Credits 100', 100],
  [6, 'OTHER50', 'Other Load 50', 50],
].map(([network, code, product, price]) => ({ network: String(network), code, product, price }));

// E-load console. Selling load needs an e-load provider account (the original used the vendor's cloud). Offline there is
// none, so everything the owner configures here is kept (key, fees, coin rates, types), the catalogue is local, and a
// purchase is refused with a clear reason instead of pretending to send load. Sales and logs lists work and can be cleared.
function createEloadHandlers({ file, mainlog, now = Date.now }) {
  const store = jsonFile(file, () => ({ apiKey: '', rate: 0, type: 1, rates: [], cashin: { rate: 0, type: 1, rates: [] }, sales: [], cashinSales: [] }));
  const read = () => ({ apiKey: '', rate: 0, type: 1, rates: [], cashin: { rate: 0, type: 1, rates: [] }, sales: [], cashinSales: [], ...store.read() });
  const change = (fn) => { const s = read(); const r = fn(s); store.write(s); return r; };
  const log = (t) => mainlog.write('system', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });

  const rates = (v) => Array.isArray(v) && v.length <= 100 && v.every((r) => r && typeof r === 'object' && Number.isInteger(r.coin) && r.coin > 0 && r.coin <= 100000)
    ? v.map((r) => ({ coin: r.coin, fee: Number.isFinite(Number(r.fee)) ? Number(r.fee) : 0, show: r.show !== false, ...(Number.isFinite(Number(r.load)) ? { load: Number(r.load) } : {}) }))
    : null;
  const fail = (message) => ({ data: { status: 0, message } });

  return {
    '@nav-67756': guarded({ data: { status: 0, message: 'Error' } }, (payload) => {
      const p = asObj(payload);
      if (p.getConfig) { const s = read(); return { apiKey: s.apiKey, rate: s.rate, type: s.type, rates: s.rates, cashin: s.cashin }; }
      if (p.getBalance) return { data: { status: 1 }, balance: 0 };
      if (p.getProduct) return { data: { status: 1, products: CATALOG } };
      if (p.checkProduct) {
        const prod = CATALOG.find((c) => c.code === p.code);
        if (!prod) return fail('Unknown product');
        return { data: { status: 0, message: NO_PROVIDER, price: prod.price, systemFee: read().rate, load: 0 } };
      }
      if (p.buyProduct) {
        const prod = CATALOG.find((c) => c.code === p.code);
        log(`E-load purchase refused (${p.code}): no provider`);
        return { data: { status: 0, load: 0, message: prod ? NO_PROVIDER : 'Unknown product' } };
      }
      if (p.setAPIkey !== undefined) {
        const key = p.setAPIkey === 'disable' ? '' : String(p.setAPIkey);
        if (key.length > 120 || /\s/.test(key)) return 'Error';
        change((s) => { s.apiKey = key; });
        log(`Admin ${key ? 'saved' : 'removed'} the e-load key`);
        return '';
      }
      if (p.createAPI) return fail('E-load accounts are created with the provider online; this machine works offline. Enter an existing key instead.');
      if (p.setRate) { if (!(Number(p.rate) > 0 && Number(p.rate) < 1000)) return 'Error'; change((s) => { s.rate = Number(p.rate); }); return ''; }
      if (p.csetRate) { if (!(Number(p.rate) > 0 && Number(p.rate) < 1000)) return 'Error'; change((s) => { s.cashin.rate = Number(p.rate); }); return ''; }
      if (p.setType) { if (![1, 2].includes(p.type)) return 'Error'; change((s) => { s.type = p.type; }); return ''; }
      if (p.csetType) { if (![1, 2].includes(p.type)) return 'Error'; change((s) => { s.cashin.type = p.type; }); return ''; }
      if (p.setRate2) { const r = rates(p.rates); if (!r) return 'Error'; change((s) => { s.rates = r; }); return ''; }
      if (p.csetRate2) { const r = rates(p.rates); if (!r) return 'Error'; change((s) => { s.cashin.rates = r; }); return ''; }
      // the provider's cash-in charge table: none offline
      if (p.cashin && p.action === 'getFee') return [];
      if (p.eloadSales) {
        if (p.action === 'clear') { change((s) => { s.sales = []; }); return ''; }
        return {}; // sections keyed "admin" / "client", each { <date>: {...} }: nothing sold offline
      }
      if (p.cashinSales) {
        if (p.action === 'clear') { change((s) => { s.cashinSales = []; }); return ''; }
        return {};
      }
      if (p.getLogs || p.getSysCashinLogs) {
        const list = read()[p.getLogs ? 'sales' : 'cashinSales'];
        return { data: { sales: list.filter((x) => (!p.number || x.mobile === p.number) && (!p.ref || x.ref === p.ref)) } };
      }
      // admin / client / cash-in log files: none are written offline
      if (p.getAdminLogs) return p.action === 'readFile' ? '' : { admin: [], client: [], cashinclient: [] };
      if (p.delClientLogs || p.delAdminLogs || p.delCashinLogs) return '';
      return fail('Error');
    }),
  };
}

module.exports = { createEloadHandlers, CATALOG, NO_PROVIDER };
