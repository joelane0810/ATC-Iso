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

test('--watch scans only its target and uses two pages without details during cooldown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc-target-'));
  const store = createStore(root);
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  const profile = store.addProfile('Dai');
  const target = store.addWatch(profile.id, 'target.com');
  store.addWatch(profile.id, 'other.com');
  const { scanFromArgs } = await import('../bin/scan.js');
  const requests = [];
  let inCooldown = false;
  const options = {
    root, store, async open() {
      assert.equal(store.getScanningWatchId(), target.id);
      return {
        async rpc(method, req) {
          assert.equal(method, 'SearchService/SearchCreatives');
          requests.push(req[3][12][1]);
          const shown = Math.floor(Date.now() / 1000);
          const ads = inCooldown ? [{
            1: 'AR1', 2: 'CR1', 3: { 3: { 2: '<img src="https://example.com/ad.png">' } },
            4: 2, 6: { 1: shown }, 7: { 1: shown }, 14: 'target.com',
          }] : [];
          return { 1: ads, 2: String(requests.length) };
        },
        async lookupRegions() { assert.fail('Không mở trang chi tiết'); },
        async captureImage() { assert.ok(!inCooldown); },
        async close() {},
      };
    },
    sync: async () => ({ pushed: false }), log: () => {},
  };
  assert.equal(await scanFromArgs([`--watch=${target.id}`], options), 'ok');
  assert.deepEqual(requests, Array(5).fill('target.com'));
  assert.equal(store.getScanLog().at(-1).light, undefined);
  requests.length = 0;
  inCooldown = true;
  const blockedAt = new Date();
  store.appendScanLog({ at: blockedAt.toISOString(), status: 'blocked' });
  const resumeAt = new Date(+blockedAt + 6 * 3_600_000).toISOString();
  assert.equal(await scanFromArgs([`--watch=${target.id}`], options), 'ok');
  assert.deepEqual(requests, ['target.com', 'target.com']);
  assert.equal(store.getScanLog().at(-1).light, true);
  assert.equal(store.getLastScan().resumeAt, resumeAt);
  assert.equal(store.getSummary(profile.id).lastScan.resumeAt, resumeAt);
  assert.equal(store.getSummary(profile.id, { now: resumeAt }).lastScan.resumeAt, undefined);
});
