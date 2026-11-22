import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanOnce } from '../bin/scan.js';
import { createStore } from '../src/store.js';

test('cooldown after a block: skips known watches, light-scans only never-scanned ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cool-'));
  const store = createStore(root);
  const p = store.addProfile('A');
  const old = store.addWatch(p.id, 'old.com');
  store.addWatch(p.id, 'new.com');
  store.mergeAds(old, [{ creativeId: 'CR1', advertiserId: 'AR1', format: 'text', domain: 'old.com',
    firstShown: '2026-11-20T00:00:00Z', lastShown: new Date().toISOString() }], new Date());
  store.appendScanLog({ at: new Date().toISOString(), status: 'blocked', watched: 1, newAds: 0 });
  const requested = [];
  const open = async () => ({
    async rpc(_m, req) { requested.push(JSON.stringify(req)); return { '1': [] }; },
    async lookupRegions() { throw new Error('không được mở trang chi tiết'); },
    async captureImage() { return null; }, async close() {},
  });
  await scanOnce({ root, store, open, sync: async () => ({ pushed: false }), log: () => {} });
  assert.ok(requested.length >= 1 && requested.length <= 2);
  assert.ok(requested.every(r => r.includes('new.com') && !r.includes('old.com')));
  // Hết mục mới -> chỉ ghi trạng thái nghỉ, không gọi ATC.
  requested.length = 0;
  store.appendScanLog({ at: new Date().toISOString(), status: 'blocked', watched: 1, newAds: 0 });
  const result = await scanOnce({ root, store, open, sync: async () => ({ pushed: false }), log: () => {} });
  assert.equal(result.status, 'cooldown');
  assert.equal(requested.length, 0);
  assert.equal(store.getScanLog().at(-1).status, 'cooldown');
});
