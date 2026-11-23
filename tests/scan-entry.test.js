import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanOnce, scanFromArgs } from '../bin/scan.js';
import { isScanLocked } from '../src/lock.js';
import { createStore } from '../src/store.js';
import { BlockedError } from '../src/atc.js';
import { readProgress } from '../src/scan-progress.js';

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

test('--regions looks up only the requested creatives, saves dates and stops when blocked', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc-region-scan-'));
  const store = createStore(root);
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'target.com');
  const now = new Date();
  store.mergeAds(watch, ['CR1', 'CR2', 'CR3'].map((creativeId, index) => ({
    creativeId, advertiserId: `AR${index + 1}`,
  })), now);
  let blocked = false;
  let opened = 0;
  const requests = [];
  const regions = [{ regionId: 2704, firstShown: '2026-11-20', lastShown: '2026-11-22' }];
  const options = {
    root, store, tabBudget: async () => 1, log: () => {},
    async open({ maxTabs, debugDir }) {
      opened++;
      assert.equal(maxTabs, 1);
      assert.equal(debugDir, undefined);
      assert.equal(await isScanLocked(join(root, 'data', '.scan.lock')), true);
      return {
        async lookupRegions(input) {
          requests.push(input);
          assert.equal(readProgress(root).watches.regions.regionsTotal, 2);
          if (blocked) throw new BlockedError();
          return regions;
        },
        rpc: () => assert.fail('Không quét trang'),
        captureImage: () => assert.fail('Không chụp ảnh'),
        async close() {},
      };
    },
    sync: () => assert.fail('Chỉ lưu dữ liệu quốc gia'),
  };

  assert.throws(() => scanFromArgs(['--regions=CR1,bad'], options), /hợp lệ/);
  assert.throws(() => scanFromArgs(['--regions=' + Array(11).fill('CR1').join(',')], options), /hợp lệ/);
  assert.equal(await scanFromArgs(['--regions=CR2,CR1'], options), 'ok');
  assert.deepEqual(requests.splice(0), [
    { advertiserId: 'AR2', creativeId: 'CR2' }, { advertiserId: 'AR1', creativeId: 'CR1' },
  ]);
  const saved = new Map(store.listAdsForProfile(id).map(ad => [ad.creativeId, ad.regions]));
  assert.deepEqual(saved.get('CR2'), [{ ...regions[0], iso: 'VN' }]);
  assert.deepEqual(saved.get('CR3'), []);
  assert.equal(readProgress(root).watches.regions.regionsDone, 2);
  assert.ok(readProgress(root).finishedAt);

  blocked = true;
  assert.equal(await scanFromArgs(['--regions=CR2,CR3'], options), 'blocked');
  assert.deepEqual(requests, [{ advertiserId: 'AR2', creativeId: 'CR2' }]);
  assert.equal(readProgress(root).watches.regions.state, 'blocked');
  assert.equal(store.getLastScan().status, 'blocked');
  assert.ok(store.getLastScan().resumeAt);
  await assert.rejects(scanFromArgs(['--regions=CR3'], options), { code: 'SCAN_COOLDOWN' });
  assert.equal(opened, 2);
});

test('full scans look up up to 80 creatives and single-watch scans keep the limit of 20', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc-region-budget-'));
  const store = createStore(root);
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'target.com');
  const now = new Date();
  const seen = [];
  const ads = Array.from({ length: 85 }, (_, index) => ({
    creativeId: `CR${index + 1}`, advertiserId: 'AR1', domain: watch.value,
    firstShown: now.toISOString(), lastShown: now.toISOString(),
  }));
  store.mergeAds(watch, ads, now);
  const options = {
    root, store, tabBudget: async () => 1, log: () => {},
    sync: async () => ({ pushed: false }),
    async open() {
      return {
        async rpc() { return { 1: [] }; },
        async lookupRegions({ creativeId }) {
          seen.push(creativeId);
          return [];
        },
        async close() {},
      };
    },
  };
  assert.equal(await scanFromArgs([`--watch=${watch.id}`], options), 'ok');
  assert.equal(seen.length, 20);
  seen.length = 0;
  const sevenDaysAgo = new Date(+now - 8 * 86_400_000);
  for (const { creativeId } of ads) store.setCreativeRegions(creativeId, [], sevenDaysAgo);
  assert.equal(await scanFromArgs([], options), 'ok');
  assert.equal(seen.length, 80);
});
