#!/usr/bin/env node
// Throws odd payloads at every admin socket event of a throwaway real main.js and reports server errors, crashes and
// events that never answer.   node scripts/fuzz-admin.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const { io: connect } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'legacy', 'wifi5-soft', 'frontend-decrypted', 'public');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(UI, 'main', 'js', 'md5.js'), 'utf8'), sandbox);

const ids = [...new Set(execFileSync('grep', ['-rhoE', "'@[A-Za-z]+-?[A-Za-z0-9!$]+'", path.join(ROOT, 'lib', 'wire')], { encoding: 'utf8' }).split('\n').map((s) => s.replace(/'/g, '')).filter(Boolean))]
  .filter((id) => !/^@(main|portal)-/.test(id));
const payloads = [undefined, null, {}, [], '', 'x', 0, -1, 1e21, true, { action: 'GET' }, { action: 'SET' }, { action: 'x'.repeat(5000) }, { mac: 'aa:bb:cc:dd:ee:ff' }, { mac: {}, code: [], value: null }, [[[]]], { __proto__: { polluted: 1 } }, JSON.parse('{"__proto__":{"p":1},"constructor":{"prototype":{"q":1}}}'), { name: '../../etc/passwd', path: '/etc/passwd', file: '../x' }];
const ask = (c, id, p) => new Promise((res) => { const t = setTimeout(() => res('<<no answer>>'), 700); const cb = (r) => { clearTimeout(t); res(r); }; p === undefined ? c.emit(id, cb) : c.emit(id, p, cb); });

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5fuzz-'));
  const gpio = path.join(root, 'gpio');
  fs.mkdirSync(path.join(gpio, 'gpio17'), { recursive: true });
  for (const f of ['export', 'unexport', 'gpio17/value', 'gpio17/direction', 'gpio17/edge']) fs.writeFileSync(path.join(gpio, f), '0');
  const p = spawn(process.execPath, [path.join(ROOT, 'main.js')], { env: { ...process.env, VENDO5_CONFIG_DIR: path.join(root, 'cfg'), VENDO5_DEFAULTS_DIR: path.join(ROOT, 'config'), VENDO5_SESSION_FILE: path.join(root, 's.json'), VENDO5_STATE_DIR: path.join(root, 'state'), VENDO5_UI_DIR: UI, VENDO5_GPIO_BASE: gpio, VENDO5_PORTAL_PORT: '0', VENDO5_FIREWALL_CMD: 'noop' } });
  let out = '';
  let dead = false;
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { out += c; });
  p.on('exit', () => { dead = true; });
  for (let i = 0; i < 100 && !/portal listening/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const port = JSON.parse(/^.*"portal listening".*$/m.exec(out)[0]).port;
  const cookie = await new Promise((res) => http.get({ port, path: '/admin' }, (r) => res(r.headers['set-cookie'][0].split(';')[0])));
  const sock = connect('http://127.0.0.1:' + port, { path: '/admin', reconnection: false, extraHeaders: { cookie } });
  await new Promise((r) => sock.on('connect', r));
  const token = await ask(sock, '@main-48931');
  const h = (token.length - 1) / 2;
  await ask(sock, '@main-66589', { uname: 'admin', username: sandbox.hexMD5(token.substring(0, h) + 'admin'), password: sandbox.hexMD5(token.substring(h) + 'admin') });
  const problems = new Map();
  const note = (id, why) => problems.set(id, [...(problems.get(id) || []), why]);
  let mark = out.length;
  for (const id of ids) {
    for (const pl of payloads) {
      if (dead) { note(id, 'SERVER DIED'); break; }
      const r = await ask(sock, id, pl);
      const fresh = out.slice(mark); mark = out.length;
      const errs = fresh.split('\n').filter((l) => /"level":"error"/.test(l));
      if (errs.length) note(id, `payload ${JSON.stringify(pl)?.slice(0, 60)} -> ${errs[0].slice(0, 200)}`);
      if (r === '<<no answer>>' && pl !== undefined) note(id, `no answer for ${JSON.stringify(pl)?.slice(0, 40)}`);
    }
    if (dead) break;
  }
  console.log(`events tried: ${ids.length}, server alive: ${!dead}`);
  for (const [id, list] of problems) console.log(id, '\n   ' + [...new Set(list)].slice(0, 3).join('\n   '));
  sock.close(); p.kill('SIGKILL');
  process.exit(0);
})();
