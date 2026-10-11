const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMainLog } = require('../lib/system/mainlog');

const dir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5log-')), 'mainlogs');
const at = (iso) => () => new Date(iso);

test('a line lands in <category>-DD-MM-YYYY.txt as "hh:mm:ss am|pm: text"', () => {
  const d = dir();
  const log = createMainLog({ dir: d, now: at('2026-10-05T09:07:03') });
  assert.equal(log.write('system', 'Admin Success Login: user admin from 10.0.0.2'), true);
  assert.deepEqual(fs.readdirSync(d), ['system-05-10-2026.txt']);
  assert.equal(fs.readFileSync(path.join(d, 'system-05-10-2026.txt'), 'utf8'), '09:07:03 am: Admin Success Login: user admin from 10.0.0.2\n');
});

test('12-hour clock edge cases: midnight, noon, 1 pm', () => {
  const d = dir();
  for (const [iso, want] of [['2026-01-02T00:05:00', '12:05:00 am'], ['2026-01-02T12:00:00', '12:00:00 pm'], ['2026-01-02T13:30:09', '01:30:09 pm'], ['2026-01-02T23:59:59', '11:59:59 pm']]) {
    createMainLog({ dir: d, now: at(iso) }).write('system', 'x');
  }
  const lines = fs.readFileSync(path.join(d, 'system-02-01-2026.txt'), 'utf8').trim().split('\n').map((l) => l.split(': ')[0]);
  assert.deepEqual(lines, ['12:05:00 am', '12:00:00 pm', '01:30:09 pm', '11:59:59 pm']);
});

test('the same day appends; a new day makes a new file; categories may contain a hyphen', () => {
  const d = dir();
  createMainLog({ dir: d, now: at('2026-10-05T10:00:00') }).write('system', 'a');
  createMainLog({ dir: d, now: at('2026-10-05T11:00:00') }).write('system', 'b');
  createMainLog({ dir: d, now: at('2026-10-06T11:00:00') }).write('system', 'c');
  createMainLog({ dir: d, now: at('2026-10-06T11:00:00') }).write('phone-rental', 'd');
  const log = createMainLog({ dir: d });
  assert.deepEqual(log.list(), ['system-05-10-2026.txt', 'phone-rental-06-10-2026.txt', 'system-06-10-2026.txt'], 'oldest day first, then by name');
  assert.equal(log.read('system-05-10-2026.txt').split('\n').filter(Boolean).length, 2);
});

test('a log line is always one line: newlines in the text cannot forge entries', () => {
  const d = dir();
  createMainLog({ dir: d, now: at('2026-10-05T10:00:00') }).write('system', 'real\n10:00:01 am: Admin Success Login: user root\r\nmore');
  const lines = fs.readFileSync(path.join(d, 'system-05-10-2026.txt'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
});

test('retention: at most N files per category, oldest removed first, other categories untouched', () => {
  const d = dir();
  for (let day = 1; day <= 6; day++) createMainLog({ dir: d, now: at(`2026-10-0${day}T10:00:00`), maxPerCategory: 3 }).write('system', 'x');
  createMainLog({ dir: d, now: at('2026-10-01T10:00:00'), maxPerCategory: 3 }).write('voucher', 'v');
  assert.deepEqual(createMainLog({ dir: d }).list().filter((n) => n.startsWith('system')), ['system-04-10-2026.txt', 'system-05-10-2026.txt', 'system-06-10-2026.txt']);
  assert.ok(createMainLog({ dir: d }).list().includes('voucher-01-10-2026.txt'));
});

test('retention orders by date, not by name (month rollover, year rollover)', () => {
  const d = dir();
  for (const iso of ['2025-12-31T10:00:00', '2026-01-01T10:00:00', '2026-01-02T10:00:00']) createMainLog({ dir: d, now: at(iso), maxPerCategory: 2 }).write('system', 'x');
  assert.deepEqual(createMainLog({ dir: d }).list(), ['system-01-01-2026.txt', 'system-02-01-2026.txt']);
});

test('read and remove only accept real log file names (no traversal, no other files)', () => {
  const d = dir();
  const log = createMainLog({ dir: d, now: at('2026-10-05T10:00:00') });
  log.write('system', 'x');
  fs.writeFileSync(path.join(path.dirname(d), 'secret.txt'), 'secret');
  for (const bad of ['../secret.txt', '../../etc/passwd', 'system-05-10-2026.txt/../../secret.txt', 'secret.txt', '', null, undefined, 5, {}, 'system-5-10-2026.txt']) {
    assert.equal(log.read(bad), '', String(bad));
    assert.equal(log.remove(bad).success, false, String(bad));
  }
  assert.ok(fs.existsSync(path.join(path.dirname(d), 'secret.txt')));
  assert.equal(log.read('system-05-10-2026.txt'), '10:00:00 am: x\n');
  assert.deepEqual(log.remove('system-05-10-2026.txt'), { success: true });
  assert.equal(log.remove('system-05-10-2026.txt').success, false, 'already gone');
});

test('removeByCategory deletes only that category', () => {
  const d = dir();
  for (const c of ['system', 'voucher', 'phone-rental']) createMainLog({ dir: d, now: at('2026-10-05T10:00:00') }).write(c, 'x');
  const log = createMainLog({ dir: d });
  assert.deepEqual(log.removeByCategory('voucher'), { success: true, removed: 1 });
  assert.deepEqual(log.list(), ['phone-rental-05-10-2026.txt', 'system-05-10-2026.txt']);
  assert.equal(log.removeByCategory('../x').success, false);
  assert.equal(log.removeByCategory('system-05').success, false);
});

test('writing never throws, even when the directory cannot be created or the category is odd', () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v5log-')), 'file');
  fs.writeFileSync(blocker, 'x');
  assert.equal(createMainLog({ dir: path.join(blocker, 'sub') }).write('system', 'x'), false);
  const d = dir();
  assert.equal(createMainLog({ dir: d, now: at('2026-10-05T10:00:00') }).write('../../evil', 'x'), true);
  assert.deepEqual(fs.readdirSync(d), ['system-05-10-2026.txt'], 'an invalid category falls back to system');
});

test('listing a missing directory is just empty', () => {
  assert.deepEqual(createMainLog({ dir: '/nonexistent-v5-dir' }).list(), []);
});
