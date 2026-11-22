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
  const firstScan = store.beginScan(at);
  store.mergeAds(competitor, [
    ad('i1', 'increase.com', at), ad('d1', 'decrease.com', at), ad('d2', 'decrease.com', old),
    ad('s1', 'stopped.com', old), ad('t1', 'steady.com', at),
  ], at, firstScan);
  store.mergeAds(project, [ad('p1', 'project.com', at), ad('p2', 'other.com', at)], at, firstScan);
  store.appendScanLog({ at, status: 'ok', scanId: firstScan });
  const nextScan = store.beginScan(now);

  store.mergeAds(competitor, [
    ad('i2', 'increase.com', now), ad('i3', 'increase.com', now), ad('i4', 'increase.com', now),
    ad('i5', 'increase.com', now), ad('n1', 'www.New.com', now),
  ], now, nextScan);
  store.mergeAds(project, [ad('p3', 'project.com', now, 'AR456')], now, nextScan);
  const region = (regionId, lastShown = at) => ({ regionId, lastShown, firstShown: null });
  store.setCreativeRegions('i1', [region(2840), region(2704, old)]);
  store.setCreativeRegions('i2', [region(2840), region(2380)]);
  store.appendScanLog({ at: now, status: 'ok', scanId: nextScan });

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
  const [group] = store.getSummary('dai', next).watches[1].groups;
  assert.deepEqual([group.status, group.delta, group.newAds], ['steady', 0, 0]);
});

test('watch snapshots roll back with ads, preserve skipped watches, and mark vanished groups stopped', t => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const a = store.addWatch(id, 'AR1');
  const b = store.addWatch(id, 'AR2');
  const ad = (creativeId, domain, lastShown) => ({ creativeId, domain, lastShown });
  const day = n => `2026-11-${n}T10:00:00.000Z`;
  const scan = (at, watched, status = 'ok') => {
    const scanId = store.beginScan(at);
    for (const [watch, ads] of watched) store.mergeAds(watch, ads, at, scanId);
    store.appendScanLog({ at, status, scanId });
  };
  scan(day(19), [[a, [ad('CR1', 'old.com', day(19))]], [b, [ad('CR3', 'b.com', day(19))]]]);
  scan(day(20), [[a, [ad('CR2', 'old.com', day(20))]]]);
  assert.equal(store.getSummary(id, day(20)).watches[0].groups[0].status, 'increase');

  assert.throws(() => store.mergeAds(a, [ad('bad', 'bad.com', day(21))], day(21), 9999), /FOREIGN KEY/);
  scan(day(21), [[b, []]], 'blocked');
  assert.equal(store.getAds(a.id).ads.bad, undefined);
  assert.equal(store.getAds(a.id).lastScanAt, day(20));
  const [unchanged] = store.getSummary(id, day(21)).watches[0].groups;
  assert.deepEqual([unchanged.status, unchanged.runningNow, unchanged.delta, unchanged.newAds], ['steady', 2, 0, 0]);

  scan(day(22), [[a, [ad('CR1', 'new.com', day(22)), ad('CR2', 'new.com', day(19))]]]);
  assert.equal(store.getAds(a.id).ads.CR2.lastShown, day(20));
  const groups = store.getSummary(id, day(22)).watches[0].groups;
  const vanished = groups.find(group => group.key === 'old.com');
  assert.deepEqual([vanished.status, vanished.runningBefore, vanished.runningNow, vanished.totalAds], ['stopped', 2, 0, 0]);
  assert.equal(groups.find(group => group.key === 'new.com').runningNow, 2);
});

test('country refresh is due after seven days and the cutoff includes the full UTC day', t => {
  const { store } = setup(t);
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'site.com');
  const at = '2026-11-22T21:00:00.000Z';
  const scanId = store.beginScan(at);
  store.mergeAds(watch, [{ creativeId: 'CR1', advertiserId: 'AR1', domain: 'site.com', lastShown: at }], at, scanId);
  store.setCreativeRegions('CR1', [
    { regionId: 2840, lastShown: '2026-11-20T00:00:00.000Z' },
    { regionId: 2704, lastShown: '2026-11-19T00:00:00.000Z' },
  ], '2026-11-15T21:00:00.000Z');
  store.appendScanLog({ at, status: 'ok', scanId });
  const pending = now => store.creativesNeedingRegions(5, { watchId: watch.id, now });
  assert.deepEqual(pending('2026-11-22T20:59:59.999Z'), []);
  assert.equal(pending(at)[0].creativeId, 'CR1');
  assert.deepEqual(store.getSummary(id, at).watches[0].groups[0].regions, [
    { regionId: 2840, iso: 'US', running: 1 },
  ]);
});

test('summary groups 5,000 ads with country data in under 1,500 ms', async t => {
  const { root, store } = setup(t);
  const { DatabaseSync } = await import('node:sqlite');
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'site.com');
  const at = second.toISOString();
  const scanId = store.beginScan(at);
  store.mergeAds(watch, Array.from({ length: 5_000 }, (_, i) => ({
    creativeId: `CR${i}`, advertiserId: 'AR1', domain: 'site.com', lastShown: at,
  })), at, scanId);
  store.appendScanLog({ at, status: 'ok', scanId });
  const db = new DatabaseSync(join(root, 'data', 'atc.db'));
  db.prepare('INSERT INTO creative_regions (creative_id, region_id, last_shown) SELECT id, 2840, ? FROM creatives').run(at);
  db.close();
  const start = performance.now();
  const { watches } = store.getSummary(id, at);
  const elapsed = performance.now() - start;
  t.diagnostic(`Tổng quan 5.000 mẫu: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 1500);
  assert.equal(watches[0].groups[0].regions[0].running, 5000);
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
