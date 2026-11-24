import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { startServer } from '../src/server.js';
import { createStore } from '../src/store.js';
import { isScanLocked, ScanBusyError, withLock } from '../src/lock.js';

async function startRequest(t, options) {
  try {
    const server = await startServer(options);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    return (path, init) => fetch(base + path, init);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.diagnostic('Socket bị giới hạn, kiểm tra cùng bộ xử lý HTTP trong bộ nhớ.');
    const listen = t.mock.method(Server.prototype, 'listen', function (_port, _host, ready) {
      ready();
      return this;
    });
    let server;
    try {
      server = await startServer(options);
    } finally {
      listen.mock.restore();
    }
    return (path, { method = 'GET', body } = {}) => new Promise((resolve) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
      req.method = method;
      req.url = path;
      let status;
      let headers;
      server.emit('request', req, {
        writeHead(code, values) {
          status = code;
          headers = values;
        },
        end(data) {
          resolve(new Response(data ?? null, { status, headers }));
        },
      });
    });
  }
}

test('Task 3 HTTP API and static files', async (t) => {
  const images = await mkdtemp(join(tmpdir(), 'atc-iso-'));
  t.after(() => rm(images, { recursive: true, force: true }));
  await writeFile(join(images, 'CR1.png'), 'ảnh');
  const profiles = [];
  const watches = [];
  const last = { status: 'ok', watched: 1, newAds: 3 };
  const store = {
    listProfiles: () => profiles,
    addProfile(name) {
      const profile = { id: 'dai', name };
      profiles.push(profile);
      return profile;
    },
    getWatchlist: () => watches,
    addWatch(pid, input, region, kind) {
      assert.equal(pid, 'dai');
      assert.equal(kind, undefined);
      if (input === 'abc') throw new Error('Không nhận ra tên miền hoặc link nhà quảng cáo');
      const watch = { id: input, label: input, region, kind: 'project' };
      watches.push(watch);
      return watch;
    },
    removeWatch(pid, wid) {
      assert.equal(pid, 'dai');
      watches.splice(watches.findIndex(({ id }) => id === wid), 1);
    },
    listAdsForProfile(pid, filters, now) {
      assert.equal(pid, 'dai');
      assert.ok(now);
      return [filters];
    },
    getLastScan: () => last,
    getScanningWatchId: () => null,
    imagesDir: () => images,
  };
  const lockPath = join(images, '.scan.lock');
  let scheduledWins = false;
  let finishScan;
  let target;
  const scan = new Promise((resolve) => { finishScan = resolve; });
  const options = {
    store, port: 0,
    triggerScan: (acquired, watchId) => {
      target = watchId;
      if (scheduledWins) throw new ScanBusyError();
      acquired();
      return scan;
    },
    waitForAcquisition: true,
    isScanning: () => isScanLocked(lockPath),
  };
  const request = await startRequest(t, options);
  const get = (path) => request(path);
  const post = (path, body) => request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const watchlist = '/api/profiles/dai/watchlist';

  assert.deepEqual(await (await get('/api/profiles')).json(), []);
  assert.equal((await post('/api/profiles', { name: 'Dai' })).status, 201);
  assert.deepEqual(await (await get('/api/profiles')).json(), [{ id: 'dai', name: 'Dai' }]);
  assert.equal((await post(watchlist, { input: 'example.com', region: 2840, kind: 'project' })).status, 201);
  assert.deepEqual(await (await get(watchlist)).json(), [
    { id: 'example.com', label: 'example.com', region: 2840, kind: 'project' },
  ]);
  const invalid = await post(watchlist, { input: 'abc' });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Không nhận ra tên miền/);
  assert.equal((await request(watchlist + '/example.com', { method: 'DELETE' })).status, 204);
  assert.deepEqual(await (await get(watchlist)).json(), []);
  assert.deepEqual(await (await get('/api/profiles/dai/ads?filter=new&q=%C3%A1o&format=image')).json(),
    [{ filter: 'new', q: 'áo', format: 'image' }]);
  assert.deepEqual(await (await get('/api/status')).json(), { scanning: false, scanningWatchId: null, last, lanUrls: [] });
  await withLock(lockPath, async () => {
    assert.deepEqual(await (await get('/api/status')).json(), { scanning: true, scanningWatchId: null, last, lanUrls: [] });
    assert.equal((await post('/api/scan')).status, 409);
  });
  scheduledWins = true;
  assert.equal((await post('/api/scan')).status, 409);
  scheduledWins = false;
  assert.equal((await post('/api/scan', { watchId: 'example-com' })).status, 202);
  assert.equal(target, 'example-com');
  assert.deepEqual(await (await get('/api/status')).json(), { scanning: true, scanningWatchId: target, last, lanUrls: [] });
  assert.equal((await post('/api/scan')).status, 409);
  finishScan();

  const home = await get('/');
  assert.equal(home.headers.get('cache-control'), 'no-store');
  const homeText = await home.text();
  assert.match(homeText, /Quét ngay/);
  assert.match(homeText, /src="\/app\.js\?v=[0-9a-z]+"/);
  assert.equal((await get('/app.js?v=abc')).status, 200);
  const app = await get('/app.js');
  assert.equal(app.headers.get('cache-control'), 'no-cache');
  assert.match(app.headers.get('content-type'), /javascript/);
  assert.equal((await get('/style.css')).headers.get('cache-control'), 'no-cache');
  const image = await get('/images/CR1.png');
  assert.equal(image.headers.get('cache-control'), null);
  assert.equal(await image.text(), 'ảnh');
  assert.equal((await get('/images/../package.json')).status, 404);
  assert.equal((await get('/images/..%2Fpackage.json')).status, 404);
});

test('profile summary and group filters follow the API contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root);
  const dai = store.addProfile('Dai');
  const lan = store.addProfile('Lan');
  const project = store.addWatch(dai.id, 'example.com', null, 'project');
  const competitor = store.addWatch(dai.id, 'AR1');
  const other = store.addWatch(lan.id, 'other.com');
  const at = new Date().toISOString();
  const request = await startRequest(t, { store, port: 0 });
  const summary = '/api/profiles/dai/summary';
  const empty = await (await request(summary)).json();
  assert.equal(empty.lastScan, null);
  assert.equal(empty.window, 'day');
  assert.equal(empty.watches.length, 2);
  assert.ok(empty.watches.every(watch => watch.spark.length === 1 && watch.groups.length === 0));
  const firstShown = `${empty.refDate}T00:00:00Z`;
  const ad = { creativeId: 'CR1', advertiserId: 'AR1', advertiserName: 'Áo Đẹp',
    domain: 'example.com', firstShown, lastShown: at, format: 'text' };
  const scanId = store.beginScan(at);
  store.mergeAds(project, [ad], at, scanId);
  store.mergeAds(competitor, [ad], at, scanId);
  store.mergeAds(other, [{ ...ad, creativeId: 'other' }], at, scanId);
  store.setCreativeRegions('CR1', [{ regionId: 2840, firstShown, lastShown: at }]);
  store.appendScanLog({ at, status: 'ok', scanId });

  const result = await (await request(summary)).json();
  assert.deepEqual(result.lastScan, { at, status: 'ok' });
  assert.deepEqual(result.totals, { newProjects: 1, newAdvertisers: 1, newAds: 2,
    increased: 0, decreased: 0, stopped: 0, runningAds: 2, increasedAds: 0, decreasedAds: 0, stoppedAds: 0,
    runningAdsPrev: 0, byType: {
      increased: { advertiser: 0, domain: 0 },
      decreased: { advertiser: 0, domain: 0 },
      stopped: { advertiser: 0, domain: 0 },
    } });
  assert.equal((await (await request(summary + '?window=7d')).json()).window, '7d');
  const series = await (await request(`/api/profiles/dai/series?watchId=${project.id}&group=AR1&days=2`)).json();
  assert.equal(series.points.length, 2);
  assert.deepEqual(series.points.at(-1), { date: result.refDate, running: 1, newAds: 1 });
  assert.deepEqual(await (await request('/api/suggest?q=%C3%81O')).json(),
    [{ type: 'advertiser', value: 'AR1', name: 'Áo Đẹp', ads: 2 }]);
  assert.deepEqual(result.watches.map(watch => watch.groups[0].key), ['AR1', 'example.com']);
  const adsUrl = '/api/profiles/dai/ads';
  const ads = await (await request(`${adsUrl}?watchId=${project.id}&group=AR1&format=text&q=example`)).json();
  assert.equal(ads.length, 1);
  assert.equal(ads[0].watchKind, 'project');
  const regions = [{ regionId: 2840, iso: 'US', firstShown, lastShown: at }];
  assert.deepEqual(ads[0].regions, regions);
  assert.deepEqual(result.watches[0].groups[0].sampleAds[0].regions, regions);
  assert.deepEqual(await (await request(`${adsUrl}?watchId=${project.id}&group=example.com`)).json(), []);
  assert.deepEqual(await (await request(`${adsUrl}?watchId=${other.id}`)).json(), []);
  assert.equal((await (await request(adsUrl)).json()).length, 1);
  assert.equal((await (await request(`${adsUrl}?from=${result.refDate}&to=${result.refDate}`)).json()).length, 1);
  assert.deepEqual(await (await request(`${adsUrl}?to=${result.prevTo}`)).json(), []);
  const explicitDay = await (await request(`${summary}?from=${result.refDate}&to=${result.refDate}`)).json();
  assert.deepEqual(explicitDay, await (await request(summary + '?window=day')).json());
  const allTime = await (await request(`/api/profiles/dai/series?watchId=${project.id}`)).json();
  assert.deepEqual(allTime, {
    refDate: result.refDate, minDate: result.refDate, from: result.refDate, to: result.refDate, bucket: 'day',
    points: [{ date: result.refDate, running: 1, newAds: 1 }],
  });
  for (const route of [summary, '/api/profiles/dai/series', adsUrl]) {
    for (const [query, message] of [
      ['from=2026-02-30', /Ngày không hợp lệ/],
      ['from=2026-11-02&to=2026-11-01', /Ngày bắt đầu/],
    ]) {
      const invalid = await request(`${route}?${query}`);
      assert.equal(invalid.status, 400);
      assert.match((await invalid.json()).error, message);
    }
  }

});

test('web GET reads under a WAL writer and reports DELETE contention in Vietnamese', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc-web-lock-'));
  const store = createStore(root);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(root, 'data', 'atc.db'));
  store.addProfile('Dai');
  const request = await startRequest(t, { store, port: 0 });
  t.after(() => {
    db.close();
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    const opened = createStore(root);
    opened.close();
    assert.equal((await request('/api/profiles')).status, 200);
    const write = await request('/api/profiles', { method: 'POST', body: '{"name":"Lan"}' });
    assert.equal(write.status, 503);
    assert.deepEqual(await write.json(), { error: 'Đang cập nhật dữ liệu, thử lại sau vài giây' });
  } finally {
    db.exec('ROLLBACK');
  }

  // A separate database starts in rollback mode before the web worker opens it.
  const deleteRoot = await mkdtemp(join(tmpdir(), 'atc-web-delete-'));
  const deleteStore = createStore(deleteRoot);
  deleteStore.close();
  const locker = new DatabaseSync(join(deleteRoot, 'data', 'atc.db'));
  assert.equal(locker.prepare('PRAGMA journal_mode = DELETE').get().journal_mode, 'delete');
  const readyStore = createStore(deleteRoot);
  const deleteRequest = await startRequest(t, { store: readyStore, port: 0 });
  t.after(() => {
    readyStore.close();
    locker.close();
    return rm(deleteRoot, { recursive: true, force: true });
  });
  locker.exec('BEGIN EXCLUSIVE');
  try {
    const start = performance.now();
    const busy = await deleteRequest('/api/profiles');
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { error: 'Đang cập nhật dữ liệu, thử lại sau vài giây' });
    assert.ok(performance.now() - start < 1000);
  } finally {
    locker.exec('ROLLBACK');
  }
  assert.equal((await deleteRequest('/api/profiles')).status, 200);
});

test('API quản lý nhóm và thùng rác theo hồ sơ', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc-groups-api-'));
  const store = createStore(root);
  t.after(() => { store.close(); return rm(root, { recursive: true, force: true }); });
  const { id } = store.addProfile('Dai');
  const other = store.addProfile('Lan');
  const request = await startRequest(t, { store, port: 0, isScanning: () => false,
    triggerScan: () => assert.fail('Mục trong thùng rác không được quét') });
  const api = '/api/profiles/' + id;
  const send = (method, path, body) => request(api + path, { method, body: JSON.stringify(body) });
  const groups = '/groups';
  const list = '/watchlist';
  const trash = '/trash';
  const created = await send('POST', groups, { name: '  Cửa hàng  ', kind: 'project' });
  assert.equal(created.status, 201);
  const group = await created.json();
  assert.deepEqual(group, { id: group.id, name: 'Cửa hàng', kind: 'project', createdAt: group.createdAt });
  assert.ok(Number.isFinite(Date.parse(group.createdAt)));
  assert.deepEqual(await (await send('GET', groups)).json(), [group]);
  assert.equal((await request('/api/profiles/' + other.id + groups + '/' + group.id, {
    method: 'PATCH', body: JSON.stringify({ name: 'Sửa nhóm' }),
  })).status, 404);
  const groupPath = groups + '/' + group.id;
  assert.deepEqual(await (await send('PATCH', groupPath, { name: 'Bán lẻ' })).json(),
    { ...group, name: 'Bán lẻ' });

  const wrongKind = await send('POST', list, { input: 'AR1', kind: 'project', groupId: group.id });
  assert.equal(wrongKind.status, 400);
  assert.deepEqual(await wrongKind.json(), { error: 'Nhóm này thuộc loại khác' });
  const first = await (await send('POST', list, { input: 'shop.com', kind: 'competitor', groupId: group.id })).json();
  const second = await (await send('POST', list, { input: 'AR1', kind: 'project' })).json();
  assert.equal(first.kind, 'project');
  assert.equal(second.kind, 'competitor');
  assert.equal(first.groupId, group.id);
  assert.equal(second.groupId, null);
  assert.equal((await send('PATCH', list + '/' + second.id, { groupId: group.id })).status, 400);
  const item = list + '/' + first.id;
  assert.equal((await (await send('PATCH', item, { groupId: null })).json()).groupId, null);
  assert.equal((await (await send('PATCH', item, { groupId: group.id })).json()).groupId, group.id);
  assert.equal((await send('DELETE', item)).status, 204);
  assert.equal((await request('/api/scan', { method: 'POST', body: JSON.stringify({ watchId: first.id }) })).status, 404);
  assert.deepEqual(await (await send('GET', list)).json(), [second]);
  const [entry] = await (await send('GET', trash)).json();
  assert.deepEqual(entry, { watchId: first.id, label: first.label, kind: 'project', groupId: group.id,
    deletedAt: entry.deletedAt, purgeAt: entry.purgeAt });
  assert.equal(Date.parse(entry.purgeAt) - Date.parse(entry.deletedAt), 60 * 86_400_000);
  assert.equal((await send('POST', trash + '/restore', { ids: [first.id] })).status, 204);
  assert.equal((await send('POST', list + '/delete', { ids: [first.id, 'missing'] })).status, 404);
  assert.deepEqual(await (await send('GET', list)).json(), [first, second]);
  assert.equal((await send('DELETE', groupPath)).status, 204);
  assert.equal((await (await send('GET', list)).json())[0].groupId, null);
  assert.equal((await send('POST', list + '/delete', { ids: [first.id, second.id] })).status, 204);
  assert.deepEqual(await (await send('GET', list)).json(), []);
  assert.equal((await send('POST', trash + '/purge', { ids: [first.id, second.id] })).status, 204);
  assert.deepEqual(await (await send('GET', trash)).json(), []);
  assert.equal((await send('POST', trash + '/restore', { ids: [first.id] })).status, 404);
});

test('region requests use the scan lock and require a creative from the profile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc-regions-api-'));
  const store = createStore(root);
  const { id } = store.addProfile('Dai');
  const other = store.addProfile('Lan');
  const watch = store.addWatch(id, 'example.com');
  const now = new Date();
  store.mergeAds(watch, [{ creativeId: 'CR1', advertiserId: 'AR1' }], now);
  const lockPath = join(root, 'data', '.scan.lock');
  let launched = 0;
  let finish;
  const lifetime = new Promise(resolve => { finish = resolve; });
  const resumeAt = new Date(+now + 60 * 60 * 1000).toISOString();
  const automaticRequests = [];
  let cooldownAtAcquisition = false;
  const request = await startRequest(t, {
    store, port: 0, waitForAcquisition: true, isScanning: () => isScanLocked(lockPath),
    triggerScan(acquired, watchId, ids, { automatic }) {
      automaticRequests.push(automatic);
      assert.equal(watchId, null);
      assert.deepEqual(ids, ['CR1']);
      if (cooldownAtAcquisition) throw Object.assign(new Error(), { code: 'SCAN_COOLDOWN', resumeAt });
      launched++;
      acquired();
      return lifetime;
    },
  });
  t.after(async () => {
    finish();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const post = (profileId = id, creativeId = 'CR1') =>
    request(`/api/profiles/${profileId}/creatives/${creativeId}/regions`, { method: 'POST' });

  assert.equal((await post(id, 'AR1')).status, 409);
  assert.equal((await post(other.id)).status, 409);
  assert.equal((await post(id, 'CR999')).status, 409);
  await withLock(lockPath, async () => {
    const response = await post();
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Đang có lượt quét.' });
  });
  assert.equal(launched, 0);
  const time = new Date(+new Date(resumeAt) + 7 * 3_600_000).toISOString().slice(11, 16);
  const cooldownMessage = { error: `Đang tạm nghỉ sau khi Google chặn — thử lại sau ${time}.` };
  cooldownAtAcquisition = true;
  const race = await request(`/api/profiles/${id}/creatives/CR1/regions`, {
    method: 'POST', body: JSON.stringify({ automatic: true }),
  });
  assert.equal(race.status, 409);
  assert.deepEqual(await race.json(), cooldownMessage);
  cooldownAtAcquisition = false;
  // Bấm tay không bị chặn bởi thời gian nghỉ: máy chủ không tự từ chối khi lượt trước bị chặn.
  store.appendScanLog({ at: now.toISOString(), status: 'blocked', resumeAt });
  assert.equal((await post()).status, 202);
  assert.equal((await post()).status, 409);
  assert.equal(launched, 1);
  assert.deepEqual(automaticRequests, [true, false]);
});
