import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../src/store.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'atc-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: createStore(root) };
}

test('addWatch dedupes across inputs and profiles while preserving regions', (t) => {
  const { root, store } = setup(t);
  const dai = store.addProfile('Dai');
  const lan = store.addProfile('Lan');
  const watch = store.addWatch(dai.id, 'https://www.Nike.com/a');
  assert.equal(watch.kind, 'competitor');
  assert.deepEqual(store.addWatch(dai.id, 'nike.com'), watch);
  const path = join(root, 'data', 'profiles', dai.id, 'watchlist.json');
  const { kind, ...legacyWatch } = watch;
  writeFileSync(path, JSON.stringify([legacyWatch]));
  assert.deepEqual(store.getWatchlist(dai.id), [watch]);
  assert.deepEqual(store.addWatch(dai.id, 'nike.com', null, 'project'), { ...watch, kind: 'project' });
  assert.deepEqual(store.getWatchlist(dai.id), [{ ...watch, kind: 'project' }]);
  store.addWatch(lan.id, 'nike.com');
  const regional = store.addWatch(lan.id, 'nike.com', 2840);
  assert.equal(regional.id, 'nike-com-r2840');
  assert.deepEqual(store.allWatches().map(({ id }) => id).sort(), [watch.id, regional.id]);
  assert.deepEqual(createStore(root).listProfiles(), [dai, lan]);
  store.removeWatch(dai.id, watch.id);
  assert.deepEqual(store.getWatchlist(dai.id), []);
  assert.equal(store.getWatchlist(lan.id).length, 2);
});

const first = new Date('2026-11-20T10:00:00Z');
const second = new Date('2026-11-22T10:00:00Z');

test('mergeAds preserves firstSeenByUs and images across scans', (t) => {
  const { store, root } = setup(t);
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'nike.com');
  const raw = { creativeId: 'CR1', lastShown: null, imageUrl: null };
  assert.equal(store.getAds(watch.id), null);
  const initial = store.mergeAds(watch, [raw], first);
  assert.deepEqual(initial.newIds, ['CR1']);
  assert.equal(initial.file.ads.CR1.image, null);
  assert.equal(initial.file.ads.CR1.platform, 'search');
  assert.equal(store.imagesDir(), join(root, 'data', 'images'));
  store.setAdImage(watch.id, 'CR1', 'images/CR1.png');
  const updated = store.mergeAds(watch, [{ ...raw, lastShown: second.toISOString() }], second);
  assert.deepEqual(updated.newIds, []);
  assert.equal(updated.file.ads.CR1.firstSeenByUs, first.toISOString());
  assert.equal(updated.file.ads.CR1.lastShown, second.toISOString());
  assert.equal(updated.file.ads.CR1.image, 'images/CR1.png');
  assert.deepEqual(store.getAds(watch.id), updated.file);
});

test('listAdsForProfile filters and sorts using fixed dates', (t) => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'nike.com');
  store.mergeAds(watch, [
    { creativeId: 'CR1', lastShown: first.toISOString(), format: 'text' },
    { creativeId: 'CR2', lastShown: null, format: 'image' },
  ], first);
  store.mergeAds(watch, [
    { creativeId: 'CR3', lastShown: second.toISOString(), format: 'image', advertiserName: 'Nike Japan' },
  ], second);

  const ids = (options) => store.listAdsForProfile(id, options, second).map(({ creativeId }) => creativeId);
  assert.deepEqual(ids({ filter: 'new' }), ['CR3']);
  assert.deepEqual(ids({ filter: 'running' }), ['CR3', 'CR1']);
  assert.deepEqual(ids({ filter: 'stopped' }), ['CR2']);
  assert.deepEqual(ids({ q: 'JAPAN', format: 'image' }), ['CR3']);
  assert.deepEqual(ids({}), ['CR3', 'CR1', 'CR2']);
  const [ad] = store.listAdsForProfile(id, {}, second);
  assert.equal(ad.watchId, watch.id);
  assert.equal(ad.watchLabel, watch.label);
});

test('JSON updates replace the file atomically and clean up temporary files', (t) => {
  const { root, store } = setup(t);
  const file = join(root, 'data', 'profiles.json');
  store.addProfile('Dai');
  const previous = statSync(file).ino;
  store.addProfile('Lan');
  assert.notEqual(statSync(file).ino, previous);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 2);
  assert.ok(readdirSync(join(root, 'data')).every((name) => !name.endsWith('.tmp')));

  const { id } = store.addProfile('Minh');
  const watch = store.addWatch(id, 'nike.com');
  const adsDir = join(root, 'data', 'ads');
  const adsFile = join(adsDir, `${watch.id}.json`);
  mkdirSync(adsFile, { recursive: true });
  assert.throws(() => store.mergeAds(watch, [], second));
  assert.deepEqual(readdirSync(adsDir), [`${watch.id}.json`]);
});

test('scan log retains the latest 30 entries', (t) => {
  const { store } = setup(t);
  assert.deepEqual(store.getScanLog(), []);
  const entries = Array.from({ length: 31 }, (_, watched) => ({ watched, status: 'ok' }));
  for (const entry of entries) store.appendScanLog(entry);
  const log = store.getScanLog();
  assert.equal(log.length, 30);
  assert.equal(log.some(({ watched }) => watched === 0), false);
  assert.ok(log.some(({ watched }) => watched === 30));
});

test('listAdsForProfile groups creative matches before filtering and keeps the earliest copy', (t) => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const laterWatch = store.addWatch(id, 'later.com');
  const earlierWatch = store.addWatch(id, 'earlier.com');
  store.mergeAds(laterWatch, [{ creativeId: 'CR1', format: 'image' }], second);
  store.mergeAds(earlierWatch, [{ creativeId: 'CR1', format: 'text' }], first);

  const results = store.listAdsForProfile(id, { q: 'later.com' }, second);
  assert.equal(results.length, 1);
  const [ad] = results;
  assert.equal(ad.firstSeenByUs, first.toISOString());
  assert.equal(ad.format, 'text');
  assert.equal(ad.watchId, earlierWatch.id);
  assert.deepEqual(ad.watchIds, [laterWatch.id, earlierWatch.id]);
  assert.deepEqual(ad.watchLabels, ['later.com', 'earlier.com']);
  assert.deepEqual(store.listAdsForProfile(id, { filter: 'new' }, second), []);
});

test('mergeAds saves the remote image URL and keeps it if a later scan omits it', (t) => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'nike.com');
  const imageUrl = 'https://example.com/creative.png';
  store.mergeAds(watch, [{ creativeId: 'CR1', imageUrl }], first);
  assert.equal(store.getAds(watch.id).ads.CR1.imageUrl, imageUrl);
  store.mergeAds(watch, [{ creativeId: 'CR1' }], second);
  assert.equal(store.getAds(watch.id).ads.CR1.imageUrl, imageUrl);
});

test('mergeAds names a shared advertiser watch from the first creative and preserves its value', (t) => {
  const { store } = setup(t);
  const dai = store.addProfile('Dai');
  const lan = store.addProfile('Lan');
  const watch = store.addWatch(dai.id, 'AR123');
  store.addWatch(lan.id, 'AR123');
  const regional = store.addWatch(lan.id, 'AR123', 2840);
  const { file } = store.mergeAds(watch, [
    { creativeId: 'CR1', advertiserName: 'Nike' },
    { creativeId: 'CR2', advertiserName: 'Another advertiser' },
  ], first);

  assert.equal(file.watch.label, 'Nike');
  assert.deepEqual(store.getWatchlist(dai.id), [{ ...watch, label: 'Nike' }]);
  assert.deepEqual(store.getWatchlist(lan.id).map(({ value, label }) => [value, label]), [
    ['AR123', 'Nike'], ['AR123', regional.label],
  ]);
  store.mergeAds(store.getWatchlist(dai.id)[0], [{ creativeId: 'CR3', advertiserName: 'New name' }], second);
  assert.equal(store.getAds(watch.id).watch.label, 'Nike');
  assert.equal(store.getWatchlist(dai.id)[0].label, 'Nike');
});
