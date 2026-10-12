const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createOfflinePageHandlers } = require('../lib/wire/offline-pages');

test('offline phone rental returns an empty client map in the shape expected by the page', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-offline-pages-'));
  try {
    const handlers = createOfflinePageHandlers({
      file: path.join(dir, 'offline-pages.json'),
      mainlog: { write() {} },
    });
    const phoneRental = handlers['@nav-332654789'].handler;
    assert.deepEqual(phoneRental({ action: 'get-users-loggedin' }), {});
    assert.deepEqual(phoneRental({ action: 'getClient' }), {});
    assert.deepEqual(phoneRental({ action: 'get-users-data' }), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
