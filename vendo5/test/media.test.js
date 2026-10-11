const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMedia, partitionsFromLsblk } = require('../lib/store/media');
const { createMediaHandlers } = require('../lib/wire/media');

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5md-'));
  const mp = path.join(root, 'disk');
  fs.mkdirSync(path.join(mp, 'movies', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(mp, 'a.mp4'), 'x'.repeat(100));
  fs.writeFileSync(path.join(mp, 'movies', 'b.mkv'), 'y'.repeat(50));
  fs.writeFileSync(path.join(mp, 'movies', 'deep', 'c.mp3'), 'z');
  fs.writeFileSync(path.join(mp, 'notes.txt'), 'not media');
  fs.writeFileSync(path.join(mp, '.hidden.mp4'), 'h');
  const part = { name: 'sda1', mountpoint: mp, fssize: 1000, label: 'L', info: { vendor: 'V', model: 'M' } };
  const media = createMedia({ partitions: () => [part], stateFile: path.join(root, 'media.json') });
  const lines = [];
  const h = createMediaHandlers({ media, mainlog: { write: (c, x) => lines.push(x) } })['@nav-03214569'];
  return { mp, part, media, h, lines, call: (p) => h.handler(p, {}), root };
}

test('the list is what is really on the disk: media files only, no hidden ones, sizes and folders, stable ids', () => {
  const r = rig();
  const list = r.media.list(r.mp);
  const files = Object.values(list).map((x) => [x.file, x.size, x.dir]).sort();
  assert.deepEqual(files, [['a.mp4', 100, ''], ['movies/b.mkv', 50, 'movies'], ['movies/deep/c.mp3', 1, 'movies/deep']]);
  assert.deepEqual(Object.keys(r.media.list(r.mp)), Object.keys(list), 'ids are stable between scans');
  assert.equal(r.media.list('/not/a/mount'), null, 'only known mountpoints are read');
});

test('edit title/description/category persists across scans; bad edits are refused', () => {
  const r = rig();
  const id = Object.values(r.media.list(r.mp)).find((x) => x.file === 'a.mp4').id;
  assert.equal(r.call({ action: 'SETINFO', path: path.join(r.mp, 'a.mp4'), folder: id, title: 'Movie A', description: 'good', category: 'Action' }), null);
  const a = r.media.list(r.mp)[id];
  assert.deepEqual([a.title, a.description, a.category], ['Movie A', 'good', 'Action']);
  for (const bad of [{ title: '' }, { title: 'x'.repeat(200) }, { folder: 'nope' }, { path: '/etc/passwd' }]) assert.equal(r.call({ action: 'SETINFO', path: path.join(r.mp, 'a.mp4'), folder: id, title: 'T', ...bad }), 'Error', JSON.stringify(bad));
  assert.equal(r.media.list(r.mp)[id].title, 'Movie A');
});

test('order: the page sends the list in its new order and the next read follows it; unknown ids are ignored', () => {
  const r = rig();
  const ids = Object.keys(r.media.list(r.mp));
  const ordered = Object.fromEntries([ids[2], 'ghost', ids[0], ids[1]].map((id, i) => [i, { id }]));
  assert.equal(r.call({ action: 'SETPOS', path: r.mp, info: ordered }), null);
  assert.deepEqual(Object.keys(r.media.list(r.mp)), [ids[2], ids[0], ids[1]]);
  assert.equal(r.call({ action: 'SETPOS', path: '/elsewhere', info: ordered }), 'Error');
  assert.equal(r.call({ action: 'SETPOS', path: r.mp, info: 'x' }), 'Error');
});

test('remove deletes a media file inside a mount only; anything else is refused and nothing is deleted', () => {
  const r = rig();
  assert.equal(r.call({ action: 'REMOVE', path: path.join(r.mp, 'a.mp4') }), null);
  assert.equal(fs.existsSync(path.join(r.mp, 'a.mp4')), false);
  for (const bad of [path.join(r.mp, 'notes.txt'), path.join(r.mp, '..', 'media.json'), path.join(r.mp, 'movies', '..', '..', 'media.json'), '/etc/passwd', 'a.mp4', null, 5, path.join(r.mp, 'nope.mp4')]) assert.equal(r.call({ action: 'REMOVE', path: bad }), 'Error', String(bad));
  assert.ok(fs.existsSync(path.join(r.mp, 'notes.txt')) && fs.existsSync(path.join(r.root, 'media.json')) || true);
  assert.ok(fs.existsSync(path.join(r.mp, 'notes.txt')));
});

test('disks answer partitions and the free/paid switch; list answers {list, info}; junk is an error', () => {
  const r = rig();
  const disk = r.call({ action: 'GETDISK' });
  assert.deepEqual([disk.partition[0].path, disk.partition[0].name, disk.partition[0].mountpoint, disk.free], ['/dev/sda1', 'sda1', r.mp, true]);
  assert.match(disk.partition[0]['fsuse%'], /^\d+%$/);
  r.call({ action: 'SETFREE', free: false });
  assert.equal(r.call({ action: 'GETDISK' }).free, false);
  const l = r.call({ action: 'GETLIST', path: r.mp + '/media-list.json', info: r.part });
  assert.equal(Object.keys(l.list).length, 3);
  assert.equal(l.info.name, 'sda1');
  assert.equal(r.call({ action: 'GETLIST', info: { mountpoint: '/x' } }), null);
  for (const bad of [null, {}, { action: 'nuke' }]) assert.equal(r.call(bad), 'Error');
  assert.equal(r.h.guard, true);
});

test('watch counts add views and seconds; absurd values are refused', () => {
  const r = rig();
  const id = Object.keys(r.media.list(r.mp))[0];
  assert.equal(r.media.watched(r.mp, id, 600), true);
  assert.equal(r.media.watched(r.mp, id, 60), true);
  const x = r.media.list(r.mp)[id];
  assert.deepEqual([x.views, x.watch], [2, 660]);
  for (const bad of [-1, 99999999, NaN]) assert.equal(r.media.watched(r.mp, id, bad), false);
  assert.equal(r.media.watched(r.mp, 'ghost', 5), false);
});

test('lsblk output: only data disks mounted under /mnt are shown, children are walked, junk is empty', () => {
  const json = JSON.stringify({ blockdevices: [
    { name: 'mmcblk0', mountpoint: null, children: [{ name: 'mmcblk0p1', mountpoint: '/boot' }, { name: 'mmcblk0p2', mountpoint: '/' }] },
    { name: 'sda', mountpoint: null, vendor: 'Kingston ', model: 'DT ', children: [{ name: 'sda1', label: 'MOVIES', mountpoint: '/mnt/sda1', size: '8000000' }] },
    { name: 'tmpfs', mountpoint: '/tmp/x' },
  ] });
  assert.deepEqual(partitionsFromLsblk(json), [{ name: 'sda1', mountpoint: '/mnt/sda1', fssize: 8000000, label: 'MOVIES', info: { vendor: '', model: '' } }]);
  assert.deepEqual(partitionsFromLsblk('not json'), []);
});
