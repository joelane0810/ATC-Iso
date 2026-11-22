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
      if (input === 'abc') throw new Error('Không nhận ra tên miền hoặc link nhà quảng cáo');
      const watch = { id: input, label: input, region, kind };
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
    getScanLog: () => [{ status: 'error' }, last],
    imagesDir: () => images,
  };
  const lockPath = join(images, '.scan.lock');
  let scheduledWins = false;
  let finishScan;
  const scan = new Promise((resolve) => { finishScan = resolve; });
  const options = {
    store, port: 0,
    triggerScan: acquired => {
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
  assert.deepEqual(await (await get('/api/status')).json(), { scanning: false, last });
  await withLock(lockPath, async () => {
    assert.deepEqual(await (await get('/api/status')).json(), { scanning: true, last });
    assert.equal((await post('/api/scan')).status, 409);
  });
  scheduledWins = true;
  assert.equal((await post('/api/scan')).status, 409);
  scheduledWins = false;
  assert.equal((await post('/api/scan')).status, 202);
  assert.equal((await post('/api/scan')).status, 409);
  finishScan();

  assert.match(await (await get('/')).text(), /Quét ngay/);
  assert.match((await get('/app.js')).headers.get('content-type'), /javascript/);
  assert.equal(await (await get('/images/CR1.png')).text(), 'ảnh');
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
  const emptyWatch = watch => ({
    watchId: watch.id, label: watch.label, kind: watch.kind, runningNow: 0, runningBefore: 0, groups: [],
  });
  assert.deepEqual(await (await request(summary)).json(), {
    lastScan: null, previousScanAt: null,
    totals: { newGroups: 0, increased: 0, decreased: 0, stopped: 0, runningAds: 0 },
    watches: [emptyWatch(project), emptyWatch(competitor)],
  });

  const ad = { creativeId: 'CR1', advertiserId: 'AR1', domain: 'example.com', lastShown: at, format: 'text' };
  store.mergeAds(project, [ad], at);
  store.mergeAds(competitor, [ad], at);
  store.mergeAds(other, [{ ...ad, creativeId: 'other' }], at);
  store.setCreativeRegions('CR1', [{ regionId: 2840, lastShown: at }]);
  store.recordGroupSnapshots(store.appendScanLog({ at, status: 'ok' }), at);

  const result = await (await request(summary)).json();
  assert.deepEqual(result.lastScan, { at, status: 'ok' });
  assert.equal(result.previousScanAt, null);
  assert.deepEqual(result.totals, { newGroups: 2, increased: 0, decreased: 0, stopped: 0, runningAds: 2 });
  assert.deepEqual(result.watches.map(watch => watch.groups[0].key), ['AR1', 'example.com']);
  const adsUrl = '/api/profiles/dai/ads';
  const ads = await (await request(`${adsUrl}?watchId=${project.id}&group=AR1&format=text&q=example`)).json();
  assert.equal(ads.length, 1);
  assert.equal(ads[0].watchKind, 'project');
  assert.deepEqual(ads[0].regions, [{ regionId: 2840, iso: 'US', lastShown: at }]);
  assert.deepEqual(await (await request(`${adsUrl}?watchId=${project.id}&group=example.com`)).json(), []);
  assert.deepEqual(await (await request(`${adsUrl}?watchId=${other.id}`)).json(), []);
  assert.equal((await (await request(adsUrl)).json()).length, 1);
});
