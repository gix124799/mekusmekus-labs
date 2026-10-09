const fs = require('node:fs');
const path = require('node:path');

const REQUIRED = {
  network: ['lan_interface'],
  vendo: ['coin_pin'],
  licensing: ['mode'],
};

let loaded = null;

const jsonFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);

function seedDefaults(dir, defaultsDir) {
  if (!fs.existsSync(defaultsDir)) throw new Error(`config dir ${dir} is empty and defaults dir ${defaultsDir} does not exist`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of jsonFiles(defaultsDir)) fs.copyFileSync(path.join(defaultsDir, f), path.join(dir, f));
}

function loadConfig(dir, defaultsDir = '/opt/vendo5/config') {
  if (!fs.existsSync(dir) || jsonFiles(dir).length === 0) seedDefaults(dir, defaultsDir);
  const cfg = {};
  for (const f of jsonFiles(dir)) {
    try {
      cfg[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      throw new Error(`config ${f}: ${e.message}`);
    }
  }
  for (const [stem, keys] of Object.entries(REQUIRED)) {
    if (!cfg[stem]) throw new Error(`config ${stem}.json: file missing`);
    for (const k of keys) {
      if (!(k in cfg[stem])) throw new Error(`config ${stem}.json: missing required key "${k}"`);
    }
  }
  loaded = cfg;
  return cfg;
}

function getConfig() {
  if (!loaded) throw new Error('config not loaded: call loadConfig first');
  return loaded;
}

module.exports = { loadConfig, getConfig, REQUIRED };
