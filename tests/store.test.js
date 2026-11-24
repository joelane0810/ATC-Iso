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
  assert.equal(watch.kind, 'project');
  assert.deepEqual(store.addWatch(dai.id, 'nike.com'), watch);
  assert.deepEqual(store.addWatch(dai.id, 'nike.com', null, 'competitor'), watch);
  assert.deepEqual(store.getWatchlist(dai.id), [watch]);
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
  assert.deepEqual(store.getWatchlist('dai'), [{ ...watch, kind: 'project', groupId: null }]);
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
      watch_creatives: 3, scans: 4, creative_regions: 0, group_snapshots: 2, watch_scans: 2,
    })) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, count, table);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  } finally {
    db.close();
  }
});

test('summary uses Vietnamese dates, all windows, and ATC dates after repeat scans', t => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const competitor = store.addWatch(id, 'AR123');
  const project = store.addWatch(id, 'new.com', null, 'project');
  const before = '2026-11-22T12:59:59Z';
  const now = '2026-11-22T13:00:00Z';
  const ad = (creativeId, domain, firstShown, lastShown = now, advertiserId = 'AR123') =>
    ({ creativeId, domain, firstShown, lastShown, advertiserId });
  const fresh = ad('today', 'www.New.com', '2026-11-21T17:00:00Z');
  const ads = [
    fresh,
    ad('week', 'week.com', '2026-11-16T00:00:00Z'),
    ad('month', 'month.com', '2026-10-24T00:00:00Z'),
    ad('old', 'older.com', '2026-10-23T00:00:00Z'),
    ad('old-interval', 'increase.com', '2026-10-01T00:00:00Z'),
    ad('extra', 'increase.com', '2026-11-22T00:00:00Z'),
    ad('gone', 'stopped.com', '2026-11-01T00:00:00Z', '2026-11-21T16:59:59Z'),
    ad('dec-old', 'decrease.com', '2026-11-01T00:00:00Z', '2026-11-21T16:59:59Z'),
    ad('dec-still', 'decrease.com', '2026-11-01T00:00:00Z'),
    ad('future', 'future.com', '2026-11-22T17:00:00Z', '2026-11-23T00:00:00Z'),
  ];
  store.mergeAds(competitor, ads, before);
  store.mergeAds(project, [fresh, ad('new-advertiser', 'new.com', fresh.firstShown, now, 'AR456')], before);
  assert.equal(store.getSummary(id, { now: before }).refDate, '2026-11-21');
  // Lần quét trước 20:00 chưa có dữ liệu của hôm nay: dù giờ đã qua 20:00, ngày tham chiếu vẫn là hôm qua.
  assert.equal(store.getSummary(id, { now }).refDate, '2026-11-21');
  // Quét lại sau 20:00 thì mới tính hôm nay.
  store.mergeAds(competitor, ads, now);
  store.mergeAds(project, [fresh, ad('new-advertiser', 'new.com', fresh.firstShown, now, 'AR456')], now);
  const summary = () => store.getSummary(id, { now });
  const first = summary();
  assert.equal(first.refDate, '2026-11-22');
  assert.equal(first.prevDate, '2026-11-21');
  assert.deepEqual(first.totals, { newProjects: 1, newAdvertisers: 2, newAds: 4,
    increased: 1, decreased: 1, stopped: 1, runningAds: 9, increasedAds: 1, decreasedAds: -1, stoppedAds: -1,
    runningAdsPrev: 7, byType: {
      increased: { advertiser: 0, domain: 1 },
      decreased: { advertiser: 0, domain: 1 },
      stopped: { advertiser: 0, domain: 1 },
    } });
  assert.deepEqual(first.watches[0].groups.slice(0, 4).map(g => [g.key, g.status, g.delta, g.followed]), [
    ['new.com', 'new', 1, true], ['increase.com', 'increase', 1, false],
    ['decrease.com', 'decrease', -1, false], ['stopped.com', 'stopped', -1, false],
  ]);
  assert.equal(first.watches[1].groups.find(g => g.key === 'AR123').followed, true);
  assert.equal(first.watches[0].spark.length, 1);
  assert.deepEqual(first.watches[0].spark.at(-1), { date: first.refDate, running: 7 });
  for (const [window, prevDate, projects, newAds] of [
    ['7d', '2026-11-15', 2, 5], ['30d', '2026-10-23', 5, 9],
  ]) {
    const result = store.getSummary(id, { window, now });
    assert.deepEqual([result.window, result.prevDate, result.totals.newProjects, result.totals.newAds],
      [window, prevDate, projects, newAds]);
  }
  const later = '2026-11-22T14:00:00Z';
  for (const at of [now, later]) { // các lần quét lại sau 20:00 không làm đổi số mới
    const scanId = store.beginScan(at);
    store.mergeAds(competitor, ads, at, scanId);
    store.appendScanLog({ at, status: 'ok', scanId });
    assert.deepEqual(summary().totals, first.totals);
  }
  assert.deepEqual(summary().lastScan, { at: now, status: 'ok' });
  const points = store.getSeries(id, { now, watchId: competitor.id, group: 'new.com', days: 90 }).points;
  assert.equal(points.length, 90);
  assert.deepEqual(points[0], { date: '2026-08-25', running: 0, newAds: 0 });
  assert.deepEqual(points.at(-2), { date: '2026-11-21', running: 0, newAds: 0 });
  assert.deepEqual(points.at(-1), { date: first.refDate, running: 1, newAds: 1 });
  assert.deepEqual(store.getSeries(id, { now, watchId: competitor.id, days: 2 }).points, [
    { date: '2026-11-21', running: 7, newAds: 0 },
    { date: '2026-11-22', running: 7, newAds: 2 },
  ]);
  assert.deepEqual(store.getSeries(id, { now, days: 1, group: undefined }).points,
    [{ date: first.refDate, running: 8, newAds: 3 }]);
});

test('ranges count ads on any overlapping day and compare the preceding equal-length range', t => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'AR1');
  const now = '2026-11-22T13:00:00Z';
  const ad = (creativeId, firstShown, lastShown, domain = creativeId + '.com') =>
    ({ creativeId, domain, firstShown, lastShown });
  store.mergeAds(watch, [
    ad('old', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'),
    ad('prior', '2026-11-08T17:00:00Z', '2026-11-15T16:59:59Z'),
    ad('spans', '2026-11-12T00:00:00Z', '2026-11-15T17:00:00Z'),
    ad('starts', '2026-11-15T17:00:00Z', '2026-11-16T00:00:00Z', 'spans.com'),
    ad('ends', '2026-11-22T00:00:00Z', now),
  ], now);

  const from = '2026-11-16';
  const to = '2026-11-22';
  const summary = store.getSummary(id, { from, to, now });
  assert.deepEqual([summary.from, summary.to, summary.prevFrom, summary.prevTo, summary.minDate],
    [from, to, '2026-11-09', '2026-11-15', '2026-07-01']);
  const [result] = summary.watches;
  assert.deepEqual([result.runningNow, result.runningPrev, result.newAds, result.newGroups], [3, 2, 2, 1]);
  assert.equal(result.groups.find(group => group.key === 'prior.com').status, 'stopped');
  assert.deepEqual(result.spark.map(point => point.running), [2, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(store.getSummary(id, { window: '7d', now }).watches, summary.watches);
  assert.deepEqual(store.getSummary(id, { from: to, to: '2026-12-01', now }),
    store.getSummary(id, { window: 'day', now }));
  assert.deepEqual(store.listAdsForProfile(id, { from, to, watchId: watch.id }, now)
    .map(ad => ad.creativeId).sort(), ['ends', 'spans', 'starts']);
  assert.deepEqual(store.listAdsForProfile(id, { from: to, to: '2026-12-01' }, now)
    .map(ad => ad.creativeId), ['ends']);

  const other = store.addWatch(id, 'other.com');
  store.mergeAds(other, [ad('starts', '2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z')], now);
  const weekly = store.getSeries(id, { now });
  assert.deepEqual([weekly.refDate, weekly.minDate, weekly.from, weekly.to, weekly.bucket],
    [to, '2026-07-01', '2026-07-01', to, 'week']);
  assert.equal(weekly.points.length, 21);
  assert.deepEqual(weekly.points[0], { date: '2026-07-01', running: 1, newAds: 1 });
  assert.deepEqual(weekly.points.at(-1), { date: '2026-11-18', running: 1, newAds: 1 });
  assert.deepEqual(weekly.points.at(-2), { date: '2026-11-11', running: 3, newAds: 2 });
  const scoped = store.getSeries(id, { watchId: other.id, now });
  assert.equal(scoped.minDate, from);
  assert.equal(scoped.bucket, 'day');
  const long = store.getSummary(id, { from: '2020-01-01', to, now }).watches[0].spark;
  assert.equal(long.length, 120);
  assert.deepEqual(long.at(-1), { date: '2026-11-18', running: 1 });
});

test('suggest counts known domains and advertisers and addWatch resolves exact names and ATC links', t => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'seed.com');
  store.mergeAds(watch, [
    { creativeId: 'a', advertiserId: 'AR123', advertiserName: 'Áo Đẹp', domain: 'www.Shop.com' },
    { creativeId: 'b', advertiserId: 'AR123', advertiserName: 'Áo Đẹp', domain: 'shop.com' },
    { creativeId: 'c', advertiserId: 'AR456', advertiserName: 'Áo khác', domain: 'shop.vn' },
    ...Array.from({ length: 10 }, (_, i) => ({ creativeId: `extra-${i}`, domain: `extra${i}.com` })),
  ], new Date());
  assert.deepEqual(store.suggest('ÁO'), [
    { type: 'advertiser', value: 'AR123', name: 'Áo Đẹp', ads: 2 },
    { type: 'advertiser', value: 'AR456', name: 'Áo khác', ads: 1 },
  ]);
  assert.deepEqual(store.suggest('WWW.SHOP'), []);
  assert.deepEqual(store.suggest('shop'), [
    { type: 'domain', value: 'shop.com', ads: 2 }, { type: 'domain', value: 'shop.vn', ads: 1 },
  ]);
  assert.equal(store.suggest('').length, 10);
  assert.deepEqual(store.suggest('missing'), []);
  const named = store.addWatch(id, '  áo ĐẸP ', null, 'project');
  assert.equal(named.kind, 'competitor');
  assert.equal(named.label, 'Áo Đẹp');
  for (const input of ['ar123', 'https://adstransparency.google.com/advertiser/AR123?region=VN',
    'adstransparency.google.com/advertiser/AR123/creative/CR1',
    '//www.adstransparency.google.com/intl/vi/advertiser/AR123/creative/CR1#top']) {
    assert.deepEqual(store.addWatch(id, input, null, 'project'), named);
  }
  const domain = store.addWatch(id, 'www.Shop.com/path', null, 'không hợp lệ');
  assert.equal(domain.kind, 'project');
  assert.deepEqual(store.addWatch(id, 'https://shop.com'), domain);
  assert.throws(() => store.addWatch(id, 'Áo'), /Không nhận ra/);
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

test('JSON import separates colliding watch IDs and establishes the first comparison', t => {
  const root = mkdtempSync(join(tmpdir(), 'atc-collision-'));
  const data = join(root, 'data');
  const at = first.toISOString();
  const profiles = [{ id: 'dai', name: 'Dai' }, { id: 'lan', name: 'Lan' }];
  const watch = value => ({ id: 'a-b-com', type: 'domain', value, label: value });
  const left = watch('a-b.com');
  const right = watch('a.b.com');
  for (const [path, contents] of Object.entries({
    'profiles.json': profiles,
    'profiles/dai/watchlist.json': [left, right],
    'profiles/lan/watchlist.json': [right],
    'ads/a-b-com.json': {
      watch: right, lastScanAt: at, ads: {
        CR1: { creativeId: 'CR1', platform: 'search', domain: right.value, lastShown: at, firstSeenByUs: at },
      },
    },
  })) {
    mkdirSync(join(data, path, '..'), { recursive: true });
    writeFileSync(join(data, path), JSON.stringify(contents));
  }
  const store = createStore(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const [a, b] = store.getWatchlist('dai');
  assert.notEqual(a.id, b.id);
  assert.equal(store.getWatchlist('lan')[0].id, b.id);
  assert.equal(store.getAds(a.id), null);
  assert.equal(store.getAds(b.id).ads.CR1.domain, right.value);
  const next = second.toISOString();
  const scanId = store.beginScan(next);
  store.mergeAds(b, [{ creativeId: 'CR1', domain: right.value, lastShown: next }], next, scanId);
  store.appendScanLog({ at: next, status: 'ok', scanId });
  const [group] = store.getSummary('dai', { now: next }).watches[1].groups;
  assert.deepEqual([group.status, group.delta, group.newAds], ['steady', 0, 0]);
});

test('watch snapshots and ads still roll back together on write failure', t => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'AR1');
  const date = '2026-11-22T13:00:00.000Z';
  assert.throws(() => store.mergeAds(watch, [{ creativeId: 'bad', domain: 'bad.com',
    firstShown: date, lastShown: date }], date, 9999), /FOREIGN KEY/);
  assert.equal(store.getAds(watch.id), null);
  assert.deepEqual(store.getSummary(id, { now: date }).watches[0].groups, []);
});

test('country refresh is due after seven days and summary uses the reference date', t => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'site.com');
  const at = '2026-11-22T21:00:00.000Z';
  const scanId = store.beginScan(at);
  store.mergeAds(watch, [{ creativeId: 'CR1', advertiserId: 'AR1', domain: 'site.com', firstShown: '2026-11-22T00:00:00Z', lastShown: at }], at, scanId);
  store.setCreativeRegions('CR1', [
    { regionId: 2840, lastShown: '2026-11-23T00:00:00.000Z' },
    { regionId: 2704, lastShown: '2026-11-19T00:00:00.000Z' },
  ], '2026-11-15T21:00:00.000Z');
  store.appendScanLog({ at, status: 'ok', scanId });
  const pending = now => store.creativesNeedingRegions(5, { watchId: watch.id, now });
  assert.deepEqual(pending('2026-11-22T20:59:59.999Z'), []);
  assert.equal(pending(at)[0].creativeId, 'CR1');
  assert.deepEqual(store.getSummary(id, { now: at }).watches[0].groups[0].regions, [
    { regionId: 2840, iso: 'US', running: 1 },
  ]);
});

test('summary groups 5,000 ads with country data in under 1,500 ms', async t => {
  const { root, store } = setup(t);
  const { DatabaseSync } = await import('node:sqlite');
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'site.com');
  const at = '2026-11-22T13:00:00.000Z';
  const scanId = store.beginScan(at);
  store.mergeAds(watch, Array.from({ length: 5_000 }, (_, i) => ({
    creativeId: `CR${i}`, advertiserId: 'AR1', domain: 'site.com', firstShown: '2026-10-24T00:00:00Z', lastShown: at,
  })), at, scanId);
  store.appendScanLog({ at, status: 'ok', scanId });
  const db = new DatabaseSync(join(root, 'data', 'atc.db'));
  db.prepare('INSERT INTO creative_regions (creative_id, region_id, last_shown) SELECT id, 2840, ? FROM creatives').run(at);
  db.close();
  const start = performance.now();
  const { watches } = store.getSummary(id, { from: '2026-06-01', to: '2026-11-22', now: at });
  const series = store.getSeries(id, { from: '2026-06-01', to: '2026-11-22', now: at });
  const elapsed = performance.now() - start;
  t.diagnostic(`Tổng quan và biểu đồ 5.000 mẫu: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 1500);
  assert.equal(watches[0].groups[0].regions[0].running, 5000);
  assert.equal(watches[0].groups[0].sampleAds.length, 4);
  assert.equal(series.bucket, 'week');
  assert.deepEqual(watches[0].spark, series.points.map(({ date, running }) => ({ date, running })));
  assert.equal(watches[0].spark.at(-1).running, 5000);
});

test('journal configuration verifies WAL and logs the switch to DELETE', async () => {
  const { configureJournal } = await import('../src/db.js');
  const queries = [];
  const messages = [];
  configureJournal(sql => {
    queries.push(sql);
    return { journal_mode: 'delete' };
  }, message => messages.push(message));
  assert.deepEqual(queries, ['PRAGMA journal_mode = WAL', 'PRAGMA journal_mode', 'PRAGMA journal_mode = DELETE']);
  assert.match(messages[0], /DELETE/);
});

test('safe transactions roll back and retry only a bounded number of times', async t => {
  const { root } = setup(t);
  const { openDb } = await import('../src/db.js');
  const db = openDb(join(root, 'data'));
  t.after(() => db.close());
  const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  let tries = 0;
  db.transaction(() => {
    db.run("INSERT INTO profiles (id, name) VALUES ('once', 'Dai')");
    if (++tries < 3) throw busy;
  });
  assert.equal(tries, 3);
  tries = 0;
  assert.throws(() => db.transaction(() => {
    tries++;
    throw busy;
  }), busy);
  assert.equal(tries, 3);
  assert.equal(db.get('SELECT count(*) AS count FROM profiles').count, 1);
});

test('concurrent first opens import the JSON only once', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execute = promisify(execFile);
  const root = mkdtempSync(join(tmpdir(), 'atc-concurrent-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'profiles.json'), '[{"id":"dai","name":"Dai"}]');
  writeFileSync(join(root, 'data', 'scan-log.json'), '[{"at":"2026-11-22T02:00:00Z","status":"ok"}]');
  const module = new URL('../src/store.js', import.meta.url).href;
  const script = `import { createStore } from ${JSON.stringify(module)};
    import { writeFileSync } from 'node:fs';
    const store = createStore(process.argv[1]);
    writeFileSync(process.argv[2], JSON.stringify([store.listProfiles().length, store.getScanLog().length]));
    store.close();`;
  const paths = [0, 1, 2].map(i => join(root, `result-${i}.json`));
  await Promise.all(paths.map(path =>
    execute(process.execPath, ['--input-type=module', '-e', script, root, path], { timeout: 5000 })));
  assert.deepEqual(paths.map(path => JSON.parse(readFileSync(path, 'utf8'))), [[1, 1], [1, 1], [1, 1]]);
});

test('version 1 upgrade keeps historical snapshots only for watches listed as completed', async t => {
  const { root, store } = setup(t);
  const { DatabaseSync } = await import('node:sqlite');
  const profile = store.addProfile('Dai');
  const a = store.addWatch(profile.id, 'a.com');
  const b = store.addWatch(profile.id, 'b.com');
  const at = first.toISOString();
  const scanId = store.beginScan(at);
  store.mergeAds(a, [{ creativeId: 'CR1', domain: 'a.com', lastShown: at }], at, scanId);
  store.mergeAds(b, [{ creativeId: 'CR2', domain: 'b.com', lastShown: at }], at, scanId);
  store.appendScanLog({ at, status: 'ok', scanId, changes: [{ watchId: a.id }] });
  const db = new DatabaseSync(join(root, 'data', 'atc.db'));
  db.exec(`
    UPDATE scans SET has_snapshots = 1;
    DROP TABLE watch_scans;
    DROP INDEX watch_creatives_dates;
    DROP INDEX creatives_region_check;
    ALTER TABLE watch_creatives DROP COLUMN first_seen;
    ALTER TABLE watch_creatives DROP COLUMN last_shown;
    ALTER TABLE watch_creatives DROP COLUMN platform;
    ALTER TABLE creatives DROP COLUMN regions_retry;
    ALTER TABLE group_snapshots DROP COLUMN name;
    DROP INDEX profile_watches_trash;
    ALTER TABLE profile_watches DROP COLUMN group_id;
    ALTER TABLE profile_watches DROP COLUMN deleted_at;
    DROP TABLE watch_groups;
    ALTER TABLE creatives DROP COLUMN domain_source;
    ALTER TABLE creatives DROP COLUMN domain_ocr_attempted_at;
    PRAGMA user_version = 1;
  `);
  const upgraded = createStore(root);
  try {
    const rows = db.prepare('SELECT watch_id, scan_id FROM watch_scans ORDER BY watch_id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].watch_id, a.id);
    assert.equal(rows[0].scan_id, scanId);
    assert.equal(rows[1].watch_id, b.id);
    assert.ok(rows[1].scan_id > scanId);
    assert.equal(upgraded.getAds(b.id).ads.CR2.lastShown, at);
  } finally {
    upgraded.close();
    db.close();
  }
});

test('opening a version 2 DB backfills domain watches only once', async t => {
  const { root, store } = setup(t);
  const { openDb } = await import('../src/db.js');
  const data = join(root, 'data');
  const profile = store.addProfile('Dai');
  const domainWatch = store.addWatch(profile.id, 'site.com');
  const advertiserWatch = store.addWatch(profile.id, 'AR123');
  const at = '2026-11-22T00:00:00Z';
  store.mergeAds(domainWatch, [
    { creativeId: 'shared', domain: '' },
    { creativeId: 'known', domain: 'reported.com' },
  ], at);
  store.mergeAds(advertiserWatch, [
    { creativeId: 'shared', domain: null },
    { creativeId: 'advertiser-only' },
  ], at);
  store.close();

  const legacy = openDb(data);
  legacy.run('DROP INDEX profile_watches_trash');
  legacy.run('ALTER TABLE profile_watches DROP COLUMN group_id');
  legacy.run('ALTER TABLE profile_watches DROP COLUMN deleted_at');
  legacy.run('DROP TABLE watch_groups');
  legacy.run('ALTER TABLE creatives DROP COLUMN domain_source');
  legacy.run('ALTER TABLE creatives DROP COLUMN domain_ocr_attempted_at');
  legacy.run('PRAGMA user_version = 2');
  legacy.close();

  const upgraded = createStore(root);
  assert.equal(upgraded.getAds(domainWatch.id).ads.shared.domain, 'site.com');
  assert.equal(upgraded.getAds(domainWatch.id).ads.known.domain, 'reported.com');
  assert.equal(upgraded.getAds(advertiserWatch.id).ads.shared.domain, null);
  assert.equal(upgraded.getAds(advertiserWatch.id).ads['advertiser-only'].domain, undefined);
  upgraded.close();

  const db = openDb(data);
  assert.deepEqual(db.all('SELECT id, domain FROM creatives ORDER BY id').map(row => [row.id, row.domain]), [
    ['advertiser-only', null], ['known', 'reported.com'], ['shared', 'site.com'],
  ]);
  db.run("UPDATE creatives SET domain = NULL WHERE id = 'shared'");
  db.run("UPDATE watch_creatives SET observation = json_remove(observation, '$.domain') WHERE watch_id = ? AND creative_id = 'shared'", domainWatch.id);
  db.close();

  const reopened = openDb(data);
  assert.equal(reopened.get("SELECT domain FROM creatives WHERE id = 'shared'").domain, null);
  assert.equal(reopened.get("SELECT json_type(observation, '$.domain') AS type FROM watch_creatives WHERE watch_id = ? AND creative_id = 'shared'", domainWatch.id).type, null);
  reopened.close();
});

test('thùng rác ẩn mục khỏi báo cáo và lượt quét, giữ quảng cáo khi thêm lại', async t => {
  const { runScan } = await import('../src/scanner.js');
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const group = store.addGroup(id, 'Bán lẻ', 'project');
  const watch = store.addWatch(id, 'shop.com', null, 'project', group.id);
  const at = '2026-11-22T14:00:00.000Z';
  store.mergeAds(watch, [{ creativeId: 'CR1', advertiserId: 'AR1', advertiserName: 'Cửa hàng',
    domain: 'shop.com', firstShown: at, lastShown: at }], at);
  assert.equal(store.getSummary(id, { now: at }).watches.length, 1);
  store.removeWatch(id, watch.id);
  assert.deepEqual(store.getSummary(id, { now: at }).watches, []);
  assert.ok(store.getSeries(id, { watchId: watch.id, now: at, days: 2 }).points.every(
    point => point.running === 0 && point.newAds === 0,
  ));
  assert.deepEqual(store.listAdsForProfile(id), []);
  assert.deepEqual(store.suggest('shop'), []);
  assert.deepEqual(store.allWatches(), []);
  let calls = 0;
  const scan = await runScan({ store, client: { rpc: () => { calls++; return {}; } } });
  assert.equal(scan.status, 'ok');
  assert.equal(scan.watched, 0);
  assert.equal(calls, 0);
  assert.deepEqual(store.addWatch(id, 'https://www.shop.com/'), watch);
  assert.deepEqual(store.getTrash(id), []);
  assert.equal(store.listAdsForProfile(id)[0].firstSeenByUs, at);
});

test('dọn thùng rác sau đúng mốc 60 ngày khi quét và khi mở DB', async t => {
  const { runScan } = await import('../src/scanner.js');
  const { openDb } = await import('../src/db.js');
  const root = mkdtempSync(join(tmpdir(), 'atc-trash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const since = Date.parse('2026-08-01T00:00:00Z');
  let time = since;
  const now = () => new Date(time);
  const store = createStore(root, { now });
  const { id } = store.addProfile('Dai');
  const scanWatch = store.addWatch(id, 'scan.com');
  store.removeWatch(id, scanWatch.id);
  time += 10;
  const openWatch = store.addWatch(id, 'open.com');
  store.removeWatch(id, openWatch.id);
  const client = { rpc: () => assert.fail('Không quét mục trong thùng rác') };
  time = since + 60 * 86_400_000;
  await runScan({ store, client, now });
  assert.equal(store.getTrash(id).length, 2);
  time++;
  await runScan({ store, client, now });
  const data = join(root, 'data');
  const memberships = db => db.all('SELECT watch_id FROM profile_watches').map(row => row.watch_id);
  const reader = openDb(data, { readOnly: true });
  assert.deepEqual(memberships(reader), [openWatch.id]);
  reader.close();
  store.close();
  time += 10;
  const reopened = openDb(data, { now });
  assert.deepEqual(memberships(reopened), []);
  reopened.close();
});

test('nâng DB phiên bản 3 giữ mục theo dõi và quảng cáo đã lưu', async t => {
  const { root, store } = setup(t);
  const { DatabaseSync } = await import('node:sqlite');
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'AR123', null, 'project');
  const at = first.toISOString();
  store.mergeAds(watch, [{ creativeId: 'CR1', advertiserId: 'AR123', domain: 'shop.com',
    firstShown: at, lastShown: at }], at);
  store.close();
  const legacy = new DatabaseSync(join(root, 'data', 'atc.db'));
  legacy.exec(`
    DROP INDEX profile_watches_trash;
    ALTER TABLE profile_watches DROP COLUMN group_id;
    ALTER TABLE profile_watches DROP COLUMN deleted_at;
    DROP TABLE watch_groups;
    ALTER TABLE creatives DROP COLUMN domain_source;
    ALTER TABLE creatives DROP COLUMN domain_ocr_attempted_at;
    PRAGMA user_version = 3;
  `);
  legacy.close();
  const upgraded = createStore(root);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.getWatchlist(id), [watch]);
  assert.deepEqual(upgraded.getTrash(id), []);
  assert.equal(upgraded.listAdsForProfile(id)[0].firstSeenByUs, at);
});

test('nâng DB phiên bản 4 phân loại lại mục theo dõi đúng một lần', async t => {
  const { root, store } = setup(t);
  const { DatabaseSync } = await import('node:sqlite');
  const { id } = store.addProfile('Dai');
  const projects = store.addGroup(id, 'Dự án', 'project');
  const advertisers = store.addGroup(id, 'Nhà quảng cáo', 'competitor');
  const domain = store.addWatch(id, 'shop.com');
  const advertiser = store.addWatch(id, 'AR1', null, undefined, advertisers.id);
  const unchanged = store.addWatch(id, 'other.com', null, undefined, projects.id);
  store.removeWatch(id, advertiser.id);
  store.close();

  const db = new DatabaseSync(join(root, 'data', 'atc.db'));
  t.after(() => db.close());
  db.prepare("UPDATE profile_watches SET kind = 'competitor', group_id = ? WHERE watch_id = ?")
    .run(advertisers.id, domain.id);
  db.prepare("UPDATE profile_watches SET kind = 'project' WHERE watch_id = ?").run(advertiser.id);
  db.exec(`UPDATE watches SET kind = CASE type WHEN 'domain' THEN 'competitor' ELSE 'project' END;
    ALTER TABLE creatives DROP COLUMN domain_source;
    ALTER TABLE creatives DROP COLUMN domain_ocr_attempted_at;
    PRAGMA user_version = 4;`);

  const upgraded = createStore(root);
  assert.deepEqual(upgraded.getWatchlist(id), [domain, unchanged]);
  const [trashed] = upgraded.getTrash(id);
  assert.equal(trashed.kind, 'competitor');
  assert.equal(trashed.groupId, advertisers.id);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
  const kind = db.prepare('SELECT kind FROM watches WHERE id = ?');
  assert.equal(kind.get(domain.id).kind, 'project');
  assert.equal(kind.get(advertiser.id).kind, 'competitor');
  upgraded.close();

  db.prepare("UPDATE profile_watches SET kind = 'competitor' WHERE watch_id = ?").run(domain.id);
  db.prepare("UPDATE watches SET kind = 'competitor' WHERE id = ?").run(domain.id);
  const reopened = createStore(root);
  t.after(() => reopened.close());
  assert.equal(reopened.getWatchlist(id)[0].kind, 'competitor');
  assert.equal(kind.get(domain.id).kind, 'competitor');
});

test('listAdsForProfile exposes OCR domain source', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createStore } = await import('../src/store.js');
  const store = createStore(mkdtempSync(join(tmpdir(), 'atc-ocr-')));
  const profile = store.addProfile("Dai");
  const watch = store.addWatch(profile.id, 'AR01234567890123456789');
  store.mergeAds(watch, [{ creativeId: "CR1", advertiserId: 'AR01234567890123456789', advertiserName: 'X', format: 'image', platform: 'search', firstShown: '2026-11-20T00:00:00Z', lastShown: '2026-11-21T00:00:00Z' }], new Date('2026-11-21T15:00:00Z'));
  store.setCreativeDomain('CR1', 'shop.com', 'ocr');
  const [ad] = store.listAdsForProfile(profile.id, {}, new Date('2026-11-21T15:00:00Z'));
  assert.equal(ad.domain, 'shop.com');
  assert.equal(ad.domainSource, 'ocr');
});

test('snapshot candidates prioritize recent ads and are retried after seven days', t => {
  const { store } = setup(t);
  const profile = store.addProfile('Dai');
  const watch = store.addWatch(profile.id, 'nike.com');
  const previewUrl = 'https://displayads-formats.googleusercontent.com/ads/content.js?a=1';
  const raw = { previewUrl, format: 'text', lastShown: second.toISOString() };
  store.mergeAds(watch, [
    { ...raw, creativeId: 'CR1', lastShown: first.toISOString() },
    { ...raw, creativeId: 'CR2' },
    { ...raw, creativeId: 'CR3', previewUrl: previewUrl.replace('content.js', 'photo.png') },
    { ...raw, creativeId: 'CR4' },
  ], second);
  store.setAdImage(watch.id, 'CR4', 'images/CR4.png');
  const ids = at => store.creativesNeedingSnapshots(300, at).map(({ creativeId }) => creativeId);
  assert.deepEqual(ids(second), ['CR2', 'CR1']);
  assert.equal(store.claimSnapshot('CR2', second), true);
  assert.equal(store.claimSnapshot('CR2', second), false);
  assert.deepEqual(ids(new Date(+second + 7 * 86_400_000 - 1)), ['CR1']);
  assert.deepEqual(ids(new Date(+second + 7 * 86_400_000)), ['CR2', 'CR1']);
});

test('background region candidates are running and have no countries', t => {
  const { store } = setup(t);
  const profile = store.addProfile('Dai');
  const watch = store.addWatch(profile.id, 'nike.com');
  const raw = { advertiserId: 'AR1', format: 'text', lastShown: second.toISOString() };
  store.mergeAds(watch, [
    { ...raw, creativeId: 'CR1' },
    { ...raw, creativeId: 'CR2' },
    { ...raw, creativeId: 'CR3', lastShown: '2026-11-17T10:00:00Z' },
  ], second);
  store.setCreativeRegions('CR2', [{ regionId: 2840, lastShown: second.toISOString() }], first);
  assert.deepEqual(store.creativesNeedingRegions(5, { now: second, runningWithoutRegions: true }),
    [{ creativeId: 'CR1', advertiserId: 'AR1' }]);
});

test('quick counts show for advertisers until a full scan is newer', (t) => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const advertiser = store.addWatch(id, 'AR123');
  store.addWatch(id, 'nike.com');
  assert.deepEqual(store.watchesWithoutScanOn('2026-11-24'), [advertiser.id]);
  store.setQuickCount(advertiser.id, { at: '2026-11-24T05:00:00.000Z', running: 40, sampled: 40, more: true, total: 120, raw: { 4: '100', 5: '200' } });
  const quick = store.getSummary(id, { now: new Date('2026-11-24T06:00:00Z') }).watches.find(w => w.watchId === advertiser.id).quickCount;
  assert.deepEqual(quick, { at: '2026-11-24T05:00:00.000Z', running: 40, sampled: 40, more: true, total: 120, totalMax: 200 });
  store.mergeAds(advertiser, [{ creativeId: 'CR1', advertiserId: 'AR123', lastShown: '2026-11-24T00:00:00Z' }], new Date('2026-11-24T07:00:00Z'));
  assert.equal(store.getSummary(id, { now: new Date('2026-11-24T08:00:00Z') }).watches.find(w => w.watchId === advertiser.id).quickCount, undefined);
  assert.deepEqual(store.watchesWithoutScanOn('2026-11-24'), []);
});

test('watchOwners names every profile that follows a watch', (t) => {
  const { store } = setup(t);
  const dai = store.addProfile('Dai');
  const hoa = store.addProfile('Hoa');
  const shared = store.addWatch(dai.id, 'nike.com');
  store.addWatch(hoa.id, 'nike.com');
  const own = store.addWatch(hoa.id, 'AR123');
  const owners = store.watchOwners([shared.id, own.id, null, 'quick']);
  assert.deepEqual(owners[shared.id].profiles.map(p => p.name), ['Dai', 'Hoa']);
  assert.deepEqual(owners[own.id].profiles.map(p => p.name), ['Hoa']);
  assert.equal(owners.quick, undefined);
});

test('groupCreativeIds lists a project inside an advertiser and skips ads checked within a day', (t) => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const advertiser = store.addWatch(id, 'AR123');
  const now = new Date('2026-11-24T08:00:00Z');
  const ad = (creativeId, domain) => ({ creativeId, advertiserId: 'AR123', domain, lastShown: now.toISOString(), firstShown: '2026-11-20T00:00:00.000Z' });
  store.mergeAds(advertiser, [ad('CR1', 'shop.example'), ad('CR2', 'shop.example'), ad('CR3', 'other.example')], now);
  const key = store.getSummary(id, { now }).watches[0].groups.find(g => g.name.includes('shop')).key;
  assert.deepEqual(store.groupCreativeIds(id, advertiser.id, key, { now }).sort(), ['CR1', 'CR2']);
  store.setCreativeRegions('CR1', [{ regionId: 2840, lastShown: '2026-11-24T00:00:00.000Z' }], now);
  assert.deepEqual(store.groupCreativeIds(id, advertiser.id, key, { now }), ['CR2']);
});
