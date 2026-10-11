const { cleanRow } = require('../money/rates');

const asObj = (v) => (v && typeof v === 'object' ? v : {});
const PIN = (v) => Number.isInteger(v) && v >= 0 && v <= 255;
const EDGES = ['rising', 'falling', 'both'];

// Settings page: the vendo (coin machine) section, the coin rate table, pins, bans, trial, redirect, footer,
// block-rule switches, game ports and the point system. Sub-vendos (other machines) do not exist here: the only
// vendo is "main".
function createSettingsHandlers({ settings, mainlog, restart = () => {}, deviceName, version = '', lanInterface = '' }) {
  const log = (t) => mainlog.write('system', t);
  const guarded = (fallback, handler) => ({ guard: true, fallback, handler });

  const vendoInfo = (s) => ({ key: s.key, sub: { main: { ...s.main, id: 'main' } }, insertBanDuration: s.insertBanDuration, insertBancount: s.insertBancount });
  const clip = (v, n) => String(v).slice(0, n);

  return {
    '@nav-22114': guarded({}, () => {
      const s = settings.read();
      return { hostname: s.hostname || deviceName, vendoInfo: vendoInfo(s) };
    }),
    '@nav-22125': guarded({}, () => {
      const s = settings.read();
      return { vendoInfo: vendoInfo(s), request: [], vendoOnline: { main: { version, interface: lanInterface } } };
    }),

    '@nav-225585': guarded({}, () => ({ id: 'main', pins: settings.read().main.pins })),

    // "Pin Setup": all five LED/relay/coin pins; the machine restarts to use them.
    '@nav-22115': guarded({}, (payload) => {
      const p = asObj(payload);
      const pins = {};
      for (const k of ['insertled', 'powerled', 'relay', 'incoin']) {
        const n = Number(p[k]);
        if (!PIN(n)) return {};
        pins[k] = n;
      }
      pins.inbill = p.inbill === '' || p.inbill === undefined ? '' : Number(p.inbill);
      pins.billmulti = p.billmulti === '' || p.billmulti === undefined ? 1 : Number(p.billmulti);
      if (pins.inbill !== '' && !PIN(pins.inbill)) return {};
      if (!(Number.isInteger(pins.billmulti) && pins.billmulti >= 1 && pins.billmulti <= 100)) return {};
      settings.change((s) => { s.main.pins = pins; s.main.coinpin = pins.incoin; s.main.relaypin = pins.relay; s.main.bill = pins.inbill; s.main.billmulti = pins.billmulti; });
      log(`Admin changed the GPIO pins (coin ${pins.incoin}, relay ${pins.relay})`);
      restart();
      return {};
    }),

    // The small per-field edits at the top of the Vendo card. Answers true on success (the page shows "Failed" otherwise).
    '@nav-36625': guarded(false, (payload) => {
      const p = asObj(payload);
      return settings.change((s) => {
        if (p.setBanduration) { if (!(Number.isInteger(p.value) && p.value >= 1 && p.value <= 1440)) return false; s.insertBanDuration = p.value; return true; }
        if (p.setBancount) { if (!(Number.isInteger(p.value) && p.value >= 1 && p.value <= 100)) return false; s.insertBancount = p.value; return true; }
        if (p.setbillmulti) { if (!(Number.isInteger(p.billmulti) && p.billmulti >= 1 && p.billmulti <= 100)) return false; s.main.billmulti = p.billmulti; s.main.pins.billmulti = p.billmulti; return true; }
        if (p.setHostname) { if (!/^[A-Za-z0-9-]{1,32}$/.test(String(p.hostname))) return false; s.hostname = p.hostname; return true; }
        if (p.setVendoName) { if (typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 32) return false; s.main.name = p.name; return true; }
        if (p.billpin) { const n = Number(p.bill); if (!PIN(n)) return false; s.main.bill = n; s.main.pins.inbill = n; return true; }
        if (p.setCoinPin) { if (!PIN(p.pin)) return false; s.main.coinpin = p.pin; s.main.pins.incoin = p.pin; return true; }
        if (p.setRelayPin) { if (!PIN(p.pin)) return false; s.main.relaypin = p.pin; s.main.pins.relay = p.pin; return true; }
        if (p.billedge !== undefined && !p.setEdge) { if (!EDGES.includes(p.billedge)) return false; s.main.billedge = p.billedge; return true; }
        if (p.setrelayactive) { if (![0, 1].includes(p.active)) return false; s.main.relaypinactive = p.active; return true; }
        if (p.setEdge) { if (!EDGES.includes(p.edge)) return false; s.main.edge = p.edge; return true; }
        if (p.setInsertbtn) { s.main.insertbtn = p.value === true || p.value === 'true'; return true; }
        return false;
      });
    }),

    // Rate table and per-vendo options. Most actions answer {config} (the new rate table) or {err}.
    '@nav-22126': guarded({ err: 'Error' }, (payload) => {
      const p = asObj(payload);
      const rep = (s) => ({ config: s.main.config });
      switch (p.action) {
        case 'edit-key':
          if (typeof p.key !== 'string' || p.key.length !== 14) return { err: 'Key must be 14 length' };
          settings.change((s) => { s.key = p.key; });
          return {};
        case 'edit-name-sub-vendo':
          if (typeof p.name !== 'string' || p.name.length < 5 || p.name.length > 32) return { err: 'Name must be 5+ length' };
          settings.change((s) => { s.main.name = p.name; });
          return {};
        case 'edit-description-sub-vendo':
          settings.change((s) => { s.main.description = clip(p.description ?? '', 80); });
          return {};
        case 'set-coundown': // (sic) the page's own spelling
          if (!(Number.isInteger(p.countdownMax) && p.countdownMax >= 10 && p.countdownMax <= 120)) return 'Error';
          settings.change((s) => { s.main.countdownMax = p.countdownMax; });
          return '';
        case 'set-corrector': {
          const d = p.coinsBlockerDelay;
          if (!(Number.isInteger(d) && d >= 500 && d <= 2000)) return 'Error';
          if (![0, 1].includes(Number(p.insertCoinType)) || !Array.isArray(p.coinCorrector) || p.coinCorrector.length > 50) return 'Error';
          settings.change((s) => { s.main.coinsBlockerDelay = d; s.main.insertCoinType = Number(p.insertCoinType); s.main.coinCorrector = p.coinCorrector; });
          return '';
        }
        case 'setType':
          if (![0, 1].includes(p.type)) return {};
          return settings.change((s) => { s.main.config.set.type = p.type; return { ...s.main, id: 'main' }; });
        case 'setShow':
          return settings.change((s) => {
            const r = s.main.config.rate.find((x) => x.coin === p.coin);
            if (r) r.show = !!p.show;
            return rep(s);
          });
        case 'add-config': {
          const row = cleanRow(p);
          if (row.err) return { err: row.err };
          return settings.change((s) => {
            if (s.main.config.rate.some((x) => x.coin === row.coin)) return { err: 'Rate Already Exist' };
            s.main.config.rate.push(row);
            log(`Admin added the rate ${row.coin} peso = ${row.minute}s`);
            return rep(s);
          });
        }
        case 'edit-config': {
          const row = cleanRow({ ...p, coin: p.newcoin });
          if (row.err) return { err: row.err };
          return settings.change((s) => {
            const rates = s.main.config.rate;
            const at = rates.findIndex((x) => x.coin === p.oldcoin);
            if (at < 0) return { err: 'Rate not found' };
            if (row.coin !== p.oldcoin && rates.some((x) => x.coin === row.coin)) return { err: 'Rate Already Exist' };
            row.show = rates[at].show;
            rates[at] = row;
            log(`Admin changed the rate ${p.oldcoin} peso -> ${row.coin} peso = ${row.minute}s`);
            return rep(s);
          });
        }
        case 'remove-config':
          return settings.change((s) => {
            s.main.config.rate = s.main.config.rate.filter((x) => x.coin !== p.coin);
            log(`Admin removed the ${p.coin} peso rate`);
            return rep(s);
          });
        default:
          return { err: 'Error' };
      }
    }),

    // Free-trial rules for new clients (applied by the customer portal; stored here).
    '@nav-36541223': guarded('Error', (payload) => {
      const p = asObj(payload);
      if (p.action === 'GET') return settings.read().trial;
      if (p.action === 'SET' && p.config && typeof p.config === 'object' && !Array.isArray(p.config) && Object.keys(p.config).length <= 50) {
        settings.change((s) => { s.trial = p.config; });
        return '';
      }
      return 'Error';
    }),

    '@nav-2311454': guarded('', (payload) => {
      const p = asObj(payload);
      if (p.action === 'GET') return JSON.stringify({ url: settings.read().redirect });
      if (p.action === 'SET' && typeof p.url === 'string' && p.url.length <= 200 && (p.url === '' || /^https?:\/\//.test(p.url))) {
        settings.change((s) => { s.redirect = p.url; });
      }
      return '';
    }),

    '@nav-453648': guarded('', (payload) => {
      const p = asObj(payload);
      // Themes page: the portal's own script (shown to clients), switched on/off
      if (p.action === 'GET2-ENABLE') return settings.read().portalTheme.enable;
      if (p.action === 'SET2-ENABLE') { settings.change((s) => { s.portalTheme.enable = !!p.enable; }); return ''; }
      if (p.action === 'GET2') return settings.read().portalTheme.script;
      if (p.action === 'SET2') {
        if (p.theme === undefined || p.theme === '') { settings.change((s) => { s.portalTheme.script = ''; }); return { success: 'Theme disabled' }; }
        if (typeof p.theme !== 'string' || p.theme.length > 20000) return { err: 'The script is too long' };
        if (typeof p.password !== 'string' || !p.password) return { err: 'Invalid password' };
        settings.change((s) => { s.portalTheme.script = p.theme; });
        log('Admin saved the portal theme script');
        return { success: 'Success' };
      }
      if (p.action === 'GET') return settings.read().footer;
      // the portal footer is shown as HTML; the original refused anything that can load or run code
      if (p.action === 'SET' && typeof p.footer === 'string' && p.footer.length <= 500 && !/<\s*(script|link|img|iframe|object|embed)|src\s*=|on\w+\s*=|javascript:/i.test(p.footer)) {
        settings.change((s) => { s.footer = p.footer; });
        return '';
      }
      return 'Error';
    }),

    // Portal themes: the two shipped themes, always allowed (no vendor licence offline), one can be set.
    '@nav-32024512': guarded({}, (payload) => {
      const p = asObj(payload);
      const THEMES = ['defualt-theme', 'newTheme'];
      const FAR = 8640000000000000;
      if (p.action === 'ctheme') return { allowed: true };
      if (p.action === 'GetList') {
        const allowed = Object.fromEntries(THEMES.map((n) => [n, { activate: 'activated', expiration: FAR }]));
        return { list: { themes: Object.fromEntries(THEMES.map((n) => [n, { url: '/theme/' }])) }, allowed, set: settings.read().portalTheme.set };
      }
      if (p.action === 'set') {
        if (!THEMES.includes(p.name)) return 'Unknown theme';
        settings.change((s) => { s.portalTheme.set = p.name; });
        log(`Admin set the portal theme ${p.name}`);
        return 'Success';
      }
      if (p.action === 'unset') { settings.change((s) => { s.portalTheme.set = ''; }); return 'Success'; }
      return {};
    }),

    '@nav-33254589': guarded({}, (payload) => {
      const p = asObj(payload);
      if (p.action === 'GET') return settings.read().pausable;
      if (p.action === 'SET') settings.change((s) => { s.pausable = { autopause: !!asObj(p.value).autopause, autolimit: !!asObj(p.value).autolimit }; });
      return settings.read().pausable;
    }),

    // The unique-id (cookie) mode is not used here: always MAC based.
    '@nav-55332145': guarded('', (payload) => {
      const p = asObj(payload);
      if (p.action === 'SET') { if (typeof p.value === 'string' && p.value.length <= 8) settings.change((s) => { s.idkey = p.value; }); return 'Success'; }
      return settings.read().idkey;
    }),
    '@nav-00332145': guarded(false, (payload) => (asObj(payload).action === 'SET' ? 'Error' : false)),

    // Game priority port lists (stored; the firewall side arrives with the network pages).
    '@nav-002331': guarded([], () => Object.entries(settings.read().gameports).map(([filename, g]) => ({ filename, name: g.name, ports: g.ports }))),
    '@nav-003321': guarded({}, (payload) => {
      const p = asObj(payload);
      const name = String(p.name || '').replace(/\W/g, '');
      const ports = Array.isArray(p.ports) ? p.ports : [];
      const ok = ports.length > 0 && ports.length <= 50 && ports.every((r) => Array.isArray(r) && r.length >= 1 && r.length <= 2 && r.every((n) => Number.isInteger(n) && n >= 1 && n <= 65535));
      if (!name || !ok) return {};
      settings.change((s) => { s.gameports[name] = { name, ports }; });
      log(`Admin saved the game port list ${name}`);
      return {};
    }),
    '@nav-003146': guarded({}, (filename) => {
      settings.change((s) => { if (Object.hasOwn(s.gameports, String(filename))) delete s.gameports[String(filename)]; });
      return {};
    }),

    // Point system: spin wheel, redeem items, and points earned per coin / voucher / credit value.
    '@nav-0092734': guarded('Error', (payload) => {
      const p = asObj(payload);
      if (p.action === 'GET') return settings.read().points;
      return settings.change((s) => {
        const pts = s.points;
        const wheel = pts.spinwheel;
        const list = ['price', 'controller', 'display'].includes(p.key) ? p.key : null;
        switch (p.action) {
          case 'Add SpinWheel':
            if (!list || !p.config || typeof p.config !== 'object' || wheel[list].length >= 100) return 'Error';
            wheel[list].push({ ...p.config, id: String(p.config.id || '') });
            return '';
          case 'Remove SpinWheel':
            if (!list) return 'Error';
            wheel[list] = wheel[list].filter((x) => x.id !== p.id);
            return '';
          case 'Set SpinWheel Order':
            if (!list || !Array.isArray(p.value)) return 'Error';
            wheel[list] = p.value.filter((x) => x && typeof x === 'object' && wheel[list].some((o) => o.id === x.id));
            return '';
          case 'Save Token':
            if (!(Number.isFinite(p.value) && p.value >= 0)) return 'Error';
            wheel.token = p.value;
            return '';
          case 'ADD-REDEEM':
            if (p.path !== 'redeem' || !/^[A-Za-z0-9]{1,16}$/.test(String(p.key)) || !p.config || typeof p.config !== 'object' || Object.keys(pts.redeem).length >= 100) return 'Error';
            pts.redeem[p.key] = p.config;
            return '';
          case 'REMOVE-REDEEM':
            delete pts.redeem[String(p.key)];
            return '';
          case 'SET':
            if (!['vendo', 'voucher', 'credit'].includes(p.path) || !(Number.isInteger(p.coin) && p.coin > 0) || !(p.point > 0)) return 'Error';
            pts[p.path] = pts[p.path].filter((r) => r.coin !== p.coin);
            pts[p.path].push({ coin: p.coin, point: p.point });
            return '';
          case 'DELETE':
            if (!['vendo', 'voucher', 'credit'].includes(p.path)) return 'Error';
            pts[p.path] = pts[p.path].filter((r) => r.coin !== p.coin);
            return '';
          default:
            return 'Error';
        }
      });
    }),

    // Files for the customer portal's own pages (#8) and its theme options: nothing uploaded yet.
    '@nav-36547111': guarded([], (payload) => (asObj(payload).action === 'GET' ? [] : 'Error')),
    '@nav-3265800': guarded({}, () => ({})),

    // Sub-vendo activation does not exist offline.
    '@nav-14433211': guarded({}, () => ({ success: false, message: 'This device runs offline: there are no sub-vendos to activate' })),
  };
}

module.exports = { createSettingsHandlers };
