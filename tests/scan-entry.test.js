import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanOnce } from '../bin/scan.js';
import { isScanLocked } from '../src/lock.js';
import { createStore } from '../src/store.js';

test('Chrome startup errors and sync results appear in the scan log', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root);
  store.appendScanLog({ status: 'ok' });
  const path = join(root, 'data', '.scan.lock');
  const errors = [];
  const sync = { pushed: false, reason: 'remote unavailable' };

  assert.equal(await scanOnce({
    root, store,
    async open() {
      assert.equal(await isScanLocked(path), true);
      throw new Error('Chrome profile is in use');
    },
    sync: async () => sync,
    log: error => errors.push(error.message),
  }), 'error');
  const latest = store.getScanLog().at(-1);
  assert.equal(latest.status, 'error');
  assert.equal(latest.error, 'Không mở được trình duyệt.');
  assert.deepEqual(latest.sync, sync);
  assert.deepEqual(errors, ['Chrome profile is in use']);
  assert.equal(await isScanLocked(path), false);
});
