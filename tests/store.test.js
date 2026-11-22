import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('legacy JSON migrates once with all rows and leaves the originals intact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'atc-migrate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const at = first.toISOString();
  const profiles = [{ id: 'dai', name: 'Dai', createdAt: at }, { id: 'lan', name: 'Lan', createdAt: at }];
  const watch = { id: 'x-com', type: 'domain', value: 'x.com', label: 'x.com', region: null, addedAt: at };
  const orphan = { ...watch, id: 'ar1', type: 'advertiser', value: 'AR1' };
  const cr1 = { creativeId: 'CR1', advertiserId: 'AR1', advertiserName: 'A', domain: 'x.com', firstSeenByUs: at };
  const cr2 = { ...cr1, creativeId: 'CR2', platform: 'search', image: 'images/CR2.png' };
  const logs = [{ status: 'ok', at }, { status: 'blocked', at, error: 'Bị chặn', sync: { pushed: false } }];
  const files = {
    'profiles.json': profiles,
    'profiles/dai/watchlist.json': [watch],
    'profiles/lan/watchlist.json': [{ ...watch, kind: 'project' }],
    'ads/x-com.json': { watch, lastScanAt: at, ads: { CR1: cr1, CR2: cr2 } },
    'ads/ar1.json': { watch: orphan, lastScanAt: at, ads: { CR1: cr1 } },
    'scan-log.json': logs,
  };
  for (const [name, contents] of Object.entries(files)) {
    const path = join(data, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(contents));
  }
  const store = createStore(root);
  assert.deepEqual(store.listProfiles(), profiles);
  assert.deepEqual(store.getWatchlist('dai'), [{ ...watch, kind: 'competitor' }]);
  assert.equal(store.getWatchlist('lan')[0].kind, 'project');
  assert.deepEqual(store.getScanLog(), logs);
  assert.equal(store.getAds('x-com').ads.CR2.image, 'images/CR2.png');
  assert.deepEqual(store.listAdsForProfile('dai').map(ad => ad.creativeId), ['CR2']);
  for (const [name, contents] of Object.entries(files)) {
    assert.equal(readFileSync(join(data, name), 'utf8'), JSON.stringify(contents));
  }
  writeFileSync(join(data, 'profiles.json'), '[]');
  assert.deepEqual(createStore(root).listProfiles(), profiles);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(data, 'atc.db'));
  try {
    for (const [table, count] of Object.entries({
      profiles: 2, watches: 2, profile_watches: 2, advertisers: 1, domains: 1, creatives: 2,
      watch_creatives: 3, scans: 2, creative_regions: 0, group_snapshots: 0,
    })) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, count, table);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  } finally {
    db.close();
  }
});

test('summary compares group snapshots and uses the profile watch kind', (t) => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const competitor = store.addWatch(id, 'AR123');
  const project = store.addWatch(id, 'project.com', null, 'project');
  const at = '2026-11-20T00:00:00.000Z';
  const now = '2026-11-22T00:00:00.000Z';
  const old = '2026-11-19T00:00:00.000Z';
  const ad = (creativeId, domain, lastShown, advertiserId = 'AR123') =>
    ({ creativeId, domain, lastShown, advertiserId, advertiserName: advertiserId });
  store.mergeAds(competitor, [
    ad('i1', 'increase.com', at), ad('d1', 'decrease.com', at), ad('d2', 'decrease.com', old),
    ad('s1', 'stopped.com', old), ad('t1', 'steady.com', at),
  ], at);
  store.mergeAds(project, [ad('p1', 'project.com', at), ad('p2', 'other.com', at)], at);
  store.recordGroupSnapshots(store.appendScanLog({ at, status: 'ok' }), at);

  store.mergeAds(competitor, [
    ad('i2', 'increase.com', now), ad('i3', 'increase.com', now), ad('i4', 'increase.com', now),
    ad('i5', 'increase.com', now), ad('n1', 'www.New.com', now),
  ], now);
  store.mergeAds(project, [ad('p3', 'project.com', now, 'AR456')], now);
  const region = (regionId, lastShown = at) => ({ regionId, lastShown, firstShown: null });
  store.setCreativeRegions('i1', [region(2840), region(2704, old)]);
  store.setCreativeRegions('i2', [region(2840), region(2380)]);
  store.recordGroupSnapshots(store.appendScanLog({ at: now, status: 'ok' }), now);

  const summary = store.getSummary(id, now);
  assert.deepEqual(summary.lastScan, { at: now, status: 'ok' });
  assert.equal(summary.previousScanAt, at);
  assert.deepEqual(summary.totals, { newGroups: 2, increased: 1, decreased: 1, stopped: 1, runningAds: 11 });
  const [opponent, initiative] = summary.watches;
  assert.equal(opponent.runningNow, 8);
  assert.equal(opponent.runningBefore, 5);
  assert.deepEqual(opponent.groups.map(g => [g.key, g.groupType, g.status, g.delta, g.newAds]), [
    ['new.com', 'domain', 'new', 1, 1],
    ['increase.com', 'domain', 'increase', 4, 4],
    ['decrease.com', 'domain', 'decrease', -1, 0],
    ['stopped.com', 'domain', 'stopped', -1, 0],
    ['steady.com', 'domain', 'steady', 0, 0],
  ]);
  const increased = opponent.groups[1];
  assert.equal(increased.firstSeen, at);
  assert.equal(increased.totalAds, 5);
  assert.deepEqual(increased.regions, [
    { regionId: 2840, iso: 'US', running: 2 }, { regionId: 2380, iso: 'IT', running: 1 },
  ]);
  assert.deepEqual(increased.sampleAds.map(ad => ad.creativeId), ['i2', 'i3', 'i4', 'i5']);
  assert.deepEqual(initiative.groups.map(g => [g.key, g.groupType, g.status, g.totalAds]), [
    ['AR456', 'advertiser', 'new', 1], ['AR123', 'advertiser', 'steady', 2],
  ]);
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
