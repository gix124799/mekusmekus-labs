const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { log } = require('../logger');

const CONFIGS = ['network', 'dhcp', 'wireless', 'system', 'firewall', 'pppoe', 'zerotier'];
const NAME = /^[A-Za-z0-9_.@\[\]-]{1,64}$/;
const OPTION = /^[A-Za-z0-9_.-]{1,64}$/;
const NOT_FOUND = 'Command failed: Not found';
const BAD = 'Command failed: Invalid argument';

// uci option values are strings, or lists of strings
const cleanValue = (v) => {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v === true ? 1 : v === false ? 0 : v);
  if (typeof v === 'string' && v.length <= 4096) return v;
  if (Array.isArray(v) && v.length <= 64 && v.every((x) => typeof x === 'string' && x.length <= 1024)) return v;
  return undefined;
};
function cleanValues(values) {
  if (values === undefined) return {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const c = cleanValue(v);
    if (!OPTION.test(k) || c === undefined || k.startsWith('.')) return null;
    out[k] = c;
  }
  return out;
}

// What a stock OpenWrt box has, so a development machine without ubus still shows real-looking pages.
function seed() {
  const s = (type, name, values = {}) => ({ '.type': type, '.name': name, '.anonymous': false, ...values });
  return {
    network: {
      loopback: s('interface', 'loopback', { device: 'lo', proto: 'static', ipaddr: '127.0.0.1', netmask: '255.0.0.0' }),
      lan: s('interface', 'lan', { device: 'br-lan', proto: 'static', ipaddr: '10.0.0.1', netmask: '255.255.224.0' }),
      wan: s('interface', 'wan', { device: 'eth0', proto: 'dhcp' }),
      br_lan: s('device', 'br_lan', { name: 'br-lan', type: 'bridge', ports: ['eth1'] }),
    },
    dhcp: {
      dnsmasq: s('dnsmasq', 'dnsmasq', { domainneeded: '1', localise_queries: '1', local: '/lan/', domain: 'lan', expandhosts: '1', authoritative: '1', readethers: '1', leasefile: '/tmp/dhcp.leases' }),
      lan: s('dhcp', 'lan', { interface: 'lan', start: '2', limit: '8190', leasetime: '72h', dhcpv4: 'server' }),
      wan: s('dhcp', 'wan', { interface: 'wan', ignore: '1' }),
    },
    wireless: {
      radio0: s('wifi-device', 'radio0', { type: 'mac80211', channel: '6', band: '2g', htmode: 'HT20', country: 'PH' }),
      default_radio0: s('wifi-iface', 'default_radio0', { device: 'radio0', network: 'lan', mode: 'ap', ssid: 'ETHYLNET', encryption: 'none' }),
    },
    system: {
      cfg0: s('system', 'cfg0', { hostname: 'ETHYLNET', timezone: 'UTC', ttylogging: '0', log_size: '64' }),
      ntp: s('timeserver', 'ntp', { enabled: '1', enable_server: '0', server: ['0.openwrt.pool.ntp.org', '1.openwrt.pool.ntp.org'] }),
    },
    firewall: {},
    pppoe: { pppoe_server: s('pppoe_server', 'pppoe_server', { interface: 'lan', service_name: ['ETHYLNET'], mtu: '1492', mru: '1492' }) },
    zerotier: { openwrt_network: s('zerotier', 'openwrt_network', { enabled: '0', join: [] }) },
  };
}

// The `ubus call uci <verb> '<json>'` interface the original admin speaks. With ubus on the machine (OpenWrt) the
// calls go to the real thing; without it (a development laptop) an emulator keeps the same semantics: reads see staged
// changes, `changes` lists them, `commit` makes them permanent, `revert` drops them.
function createUci({ runCommand, stateFile, hasUbus = true }) {
  let committed = null;
  let working = null;
  let ops = {}; // config -> [["set"|"add"|"remove", section, option?, value?]]

  function load() {
    if (committed) return;
    try { committed = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { committed = seed(); }
    for (const c of CONFIGS) committed[c] = committed[c] || {};
    working = structuredClone(committed);
  }
  const persist = () => {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify(committed));
      fs.renameSync(stateFile + '.tmp', stateFile);
    } catch (e) { log('error', 'could not save the emulated uci state', { error: e.message }); }
  };

  function emulate(verb, req) {
    load();
    const config = req.config;
    if (!CONFIGS.includes(config)) throw new Error(NOT_FOUND);
    const cfg = working[config];
    const op = (...a) => { (ops[config] = ops[config] || []).push(a); };
    switch (verb) {
      case 'get': {
        if (req.section === undefined) {
          const values = {};
          for (const [n, v] of Object.entries(cfg)) if (!req.type || v['.type'] === req.type) values[n] = v;
          return { values };
        }
        if (!NAME.test(String(req.section)) || !Object.hasOwn(cfg, req.section)) throw new Error(NOT_FOUND);
        if (req.option !== undefined) {
          if (!Object.hasOwn(cfg[req.section], String(req.option)) || String(req.option).startsWith('.')) throw new Error(NOT_FOUND);
          return { value: cfg[req.section][req.option] };
        }
        return { values: cfg[req.section] };
      }
      case 'set': {
        const values = cleanValues(req.values);
        if (!values || !NAME.test(String(req.section))) throw new Error(BAD);
        if (!Object.hasOwn(cfg, req.section)) throw new Error(NOT_FOUND);
        for (const [k, v] of Object.entries(values)) { cfg[req.section][k] = v; op('set', req.section, k, v); }
        return null;
      }
      case 'add': {
        const values = cleanValues(req.values);
        if (!values || !OPTION.test(String(req.type))) throw new Error(BAD);
        const name = req.name === undefined ? `cfg${crypto.randomBytes(3).toString('hex')}` : String(req.name);
        if (!NAME.test(name)) throw new Error(BAD);
        if (Object.hasOwn(cfg, name)) throw new Error('Command failed: Invalid argument');
        cfg[name] = { '.type': req.type, '.name': name, '.anonymous': req.name === undefined, ...values };
        op('add', name, req.type);
        return { section: name };
      }
      case 'delete': {
        if (!NAME.test(String(req.section)) || !Object.hasOwn(cfg, req.section)) throw new Error(NOT_FOUND);
        if (req.option !== undefined) {
          if (!Object.hasOwn(cfg[req.section], String(req.option)) || String(req.option).startsWith('.')) throw new Error(NOT_FOUND);
          delete cfg[req.section][req.option];
          op('remove', req.section, req.option);
        } else {
          delete cfg[req.section];
          op('remove', req.section);
        }
        return null;
      }
      case 'changes': return (ops[config] || []).length ? { changes: ops[config] } : {};
      case 'commit':
        committed[config] = structuredClone(working[config]);
        delete ops[config];
        persist();
        return null;
      case 'revert':
        working[config] = structuredClone(committed[config]);
        delete ops[config];
        return null;
      default: throw new Error(BAD);
    }
  }

  // verb + request object -> what the page expects: parsed JSON for get/add/changes, {stdout, stderr} otherwise.
  function call(verb, req) {
    try {
      let out;
      if (hasUbus) {
        const text = runCommand(['ubus', 'call', 'uci', verb, JSON.stringify(req)]);
        out = text && text.trim() ? JSON.parse(text) : null;
      } else {
        out = emulate(verb, req);
      }
      return out === null ? { stdout: '', stderr: '' } : out;
    } catch (e) {
      const stderr = String((e && e.stderr) || (e && e.message) || 'Command failed').trim().split('\n')[0].slice(0, 200);
      return { stdout: '', stderr };
    }
  }

  return { call, emulated: !hasUbus, CONFIGS };
}

module.exports = { createUci, seed, CONFIGS };
