import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Task 1 is developed on another branch. Stub its module only in this test.
const atcStub = `
  export class BlockedError extends Error {}
  export const buildSearchCreativesReq = ({ watch, pageToken }) => ({ watch, pageToken });
  export const parseCreatives = response => response;
`;
const stubUrl = 'data:text/javascript,' + encodeURIComponent(atcStub);
register('data:text/javascript,' + encodeURIComponent(`
  export function resolve(specifier, context, next) {
    if (specifier === './atc.js' && context.parentURL?.endsWith('/src/scanner.js')) {
      return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
    }
    return next(specifier, context);
  }
`));
const { BlockedError } = await import(stubUrl);
const { runScan } = await import('../src/scanner.js');
const { isScanLocked, withLock } = await import('../src/lock.js');

const now = () => new Date('2026-11-22T02:00:00Z');
const first = { id: 'first', type: 'domain', value: 'first.example' };
const second = { id: 'second', type: 'domain', value: 'second.example' };

function setup(respond, { watches = [first], previous = [], capture, saved = {}, previousAt } = {}) {
  const files = new Map();
  if (previous.length) files.set(first.id, { lastScanAt: previousAt, ads: Object.fromEntries(previous.map(id => [id, saved[id] ?? {}])) });
  const logs = [];
  const requests = [];
  const captures = [];
  const images = [];
  const store = {
    allWatches: () => watches,
    getAds: id => files.get(id) ?? null,
    mergeAds(watch, ads) {
      const file = files.get(watch.id) ?? { ads: {} };
      const newIds = [];
      for (const ad of ads) {
        if (!Object.hasOwn(file.ads, ad.creativeId)) newIds.push(ad.creativeId);
        file.ads[ad.creativeId] = { ...file.ads[ad.creativeId], ...ad, platform: 'search' };
      }
      files.set(watch.id, file);
      return { file, newIds };
    },
    imagesDir: () => join(tmpdir(), 'images'),
    setAdImage: (...args) => images.push(args),
    appendScanLog: entry => logs.push(entry),
  };
  const client = {
    async rpc(method, req) {
      assert.equal(method, 'SearchService/SearchCreatives');
      requests.push(req);
      return respond(req, requests.length);
    },
    async captureImage(ad, destNoExt) {
      captures.push(ad.creativeId);
      return capture ? capture(ad, destNoExt) : destNoExt + '.png';
    },
  };
  const waits = [];
  const waitForCapture = async ms => { waits.push(ms); };
  return {
    scan: () => runScan({ store, client, now, log: () => {}, waitForCapture, maxDetails: 60 }),
    files, logs, requests, captures, images, waits,
  };
}

const page = (ids, nextToken) => ({ ads: ids.map(creativeId => ({ creativeId, previewUrl: 'https://example.com/content.js' })), nextToken });

test('first scan stops after five pages', async () => {
  const run = setup((req, n) => page(['CR' + n], String(n)));
  assert.deepEqual(await run.scan(), { status: 'ok', watched: 1, newAds: 5 });
  assert.deepEqual(run.requests.map(req => req.pageToken), [null, '1', '2', '3', '4']);
  assert.equal(run.captures.length, 5);
  assert.deepEqual(run.images[0], [first.id, 'CR1', 'images/CR1.png']);
  assert.equal(run.logs[0].status, 'ok');
});

test('later scan reads up to three extra pages after a page with all known ads', async () => {
  const run = setup((req, n) => page(n === 1 ? ['CRnew', 'CRold'] : n === 4 ? ['CRlater'] : ['CRold'], String(n)), {
    previous: ['CRold'], saved: { CRold: { platform: 'search', image: 'images/CRold.png' } },
  });
  assert.deepEqual(await run.scan(), { status: 'ok', watched: 1, newAds: 2 });
  assert.equal(run.requests.length, 5);
  assert.deepEqual(run.captures, ['CRnew', 'CRlater']);
});

test('blocking stops the scan and retains completed watches', async () => {
  const third = { ...second, id: 'third' };
  const run = setup(({ watch }, n) => {
    if (n === 1) return page(['CR1'], null);
    if (watch === second && n === 2) return page(['CR2'], 'next');
    throw new BlockedError('Bị chặn');
  }, { watches: [first, second, third] });
  assert.equal((await run.scan()).status, 'blocked');
  assert.deepEqual(run.requests.map(req => req.watch), [first, second, second]);
  assert.deepEqual(Object.keys(run.files.get(first.id).ads), ['CR1']);
  assert.equal(run.files.has(second.id), false);
  assert.deepEqual(run.captures, ['CR1']);
  assert.equal(run.logs[0].status, 'blocked');
});

test('lock prevents concurrent scan', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atc-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.scan.lock');
  await withLock(path, async () => {
    await assert.rejects(withLock(path, () => assert.fail('second scan entered')), { message: 'ĐANG_QUÉT' });
  });
  await assert.rejects(withLock(path, () => { throw new Error('test failure'); }), /test failure/);
  assert.equal(await withLock(path, () => 42), 42);
  await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 4 * 3600_000 }));
  await assert.rejects(withLock(path, () => 43), { code: 'SCAN_BUSY' });
});

test('a preview block stops subsequent captures and watches', async () => {
  const run = setup(() => page(['CR1', 'CR2'], null), {
    watches: [first, second],
    capture() { throw new BlockedError('Bị chặn khi tải ảnh'); },
  });
  assert.equal((await run.scan()).status, 'blocked');
  assert.deepEqual(run.captures, ['CR1']);
  assert.equal(run.requests.length, 1);
  assert.equal(run.logs[0].status, 'blocked');
});

test('a scan retries at most 20 old ads with missing images, even off the current page', async () => {
  const ids = Array.from({ length: 23 }, (_, i) => 'CR' + i);
  const saved = Object.fromEntries(ids.map(creativeId => [creativeId, {
    creativeId, format: 'video', previewUrl: 'https://example.com/content.js',
  }]));
  saved.CR0.image = 'images/CR0.png';
  const run = setup(() => page([], null), { previous: ids, saved });
  assert.equal((await run.scan()).newAds, 0);
  assert.deepEqual(run.captures, ids.slice(1, 21));
});

test('two processes contend for a stale lock and only one acquires it', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atc-lock-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.scan.lock');
  await writeFile(path, '{"pid":2147483647}');
  const contender = spawn('/usr/bin/perl', ['-e', `
    use Fcntl qw(:flock);
    open my $lock, ">>", $ARGV[0] or die "$!";
    flock($lock, LOCK_EX | LOCK_NB) or die "$!";
    $| = 1;
    print "held\n";
    1 while read(STDIN, my $buffer, 1);
  `, path]);
  const exit = once(contender, 'close');
  try {
    const [reply] = await Promise.race([
      once(contender.stdout, 'data'),
      exit.then(([code]) => { throw new Error('Contender exited before replying: ' + code); }),
    ]);
    assert.equal(reply.toString().trim(), 'held');
    assert.equal(await isScanLocked(path), true);
    await assert.rejects(withLock(path, () => assert.fail('second process entered')), { code: 'SCAN_BUSY' });
  } finally {
    contender.stdin.end();
    assert.deepEqual(await exit, [0, null]);
  }
  assert.equal(await isScanLocked(path), false);
  assert.equal(await withLock(path, () => 42), 42);
});

test('capture attempts share a limit of 40 and a capture interval across watches', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => 'CR' + i);
  const run = setup(() => page(ids, null), { watches: [first, second], capture: () => null });
  assert.deepEqual(await run.scan(), { status: 'ok', watched: 2, newAds: 60 });
  assert.deepEqual(run.captures, [...ids, ...ids.slice(0, 10)]);
  assert.equal(run.waits.length, 39);
  assert.ok(run.waits.every(ms => ms > 0 && ms <= 1500));
});

test('missing current imageUrl still uses the saved archive URL on a video ad', async () => {
  const imageUrl = 'https://tpc.googlesyndication.com/archive/simgad/123';
  const run = setup(() => page([], null), {
    previous: ['CR1'],
    saved: { CR1: { creativeId: 'CR1', format: 'video', previewUrl: imageUrl } },
    capture(ad, dest) {
      assert.equal(ad.imageUrl, imageUrl);
      return dest + '.jpg';
    },
  });
  assert.equal((await run.scan()).status, 'ok');
  assert.deepEqual(run.images, [[first.id, 'CR1', 'images/CR1.jpg']]);
});

test('scan continues past unconfirmed ads and records search changes at the two-day boundary', async () => {
  const watch = { ...first, label: 'Dự án', kind: 'project' };
  const boundary = '2026-11-20T02:00:00Z';
  const old = lastShown => ({ platform: 'search', lastShown });
  const saved = {
    legacy: {},
    newlyStopped: old('2026-11-19T02:00:00Z'),
    alreadyStopped: old('2026-11-19T01:59:59Z'),
    running: old(boundary),
    hidden: { lastShown: boundary },
  };
  const run = setup((req, n) => ({
    ads: n === 1 ? [{ creativeId: 'legacy' }]
      : [{ creativeId: 'new', lastShown: boundary }],
    nextToken: n === 1 ? 'next' : null,
  }), {
    watches: [watch], previous: Object.keys(saved), saved, previousAt: '2026-11-21T02:00:00Z',
  });

  assert.equal((await run.scan()).status, 'ok');
  assert.deepEqual(run.requests.map(req => req.pageToken), [null, 'next']);
  assert.deepEqual(run.logs[0].changes, [{
    watchId: watch.id, label: watch.label, kind: 'project',
    newIds: ['new'], stoppedIds: ['newlyStopped'], running: 2, total: 5,
  }]);
});

test('later scans stop after 10 pages even when every page has new ads', async () => {
  const { runScan } = await import('../src/scanner.js');
  const { createStore } = await import('../src/store.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const store = createStore(root);
  const p = store.addProfile('A'); store.addWatch(p.id, 'cap.com');
  let n = 0;
  const page = () => { const id = `CR${n++}`; return { ads: [{ creativeId: id, advertiserId: 'AR1', format: 'text', firstShown: '2026-11-20T00:00:00Z', lastShown: '2026-11-22T00:00:00Z', domain: 'cap.com' }], nextToken: `t${n}` }; };
  const client = { calls: 0, async rpc(method) { if (method.startsWith('LookupService/')) return []; this.calls++; return page(); }, async captureImage() { return null; }, async close() {} };
  await runScan({ store, client, log: () => {}, maxDetails: 60 });
  client.calls = 0;
  await runScan({ store, client, log: () => {}, maxDetails: 60 });
  assert.equal(client.calls, 10);
});

test('details prioritize new ads per watch and share a limit of 30 across watches', async t => {
  const { createStore } = await import('../src/store.js');
  const root = await mkdtemp(join(tmpdir(), 'atc-detail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root);
  const { id } = store.addProfile('Dai');
  const first = store.addWatch(id, 'first.com');
  const second = store.addWatch(id, 'second.com');
  const lastShown = now().toISOString();
  const ad = creativeId => ({ creativeId, advertiserId: 'AR1', lastShown });
  store.mergeAds(first, [ad('old'), { ...ad('inactive'), lastShown: '2026-11-10T00:00:00Z' }],
    '2026-11-21T02:00:00Z');
  const calls = [];
  const client = {
    async rpc(method, req) {
      assert.equal(method, 'SearchService/SearchCreatives');
      calls.push(req.watch.id);
      return { ads: Array.from({ length: 16 }, (_, i) => ad(`${req.watch.id}-${i}`)) };
    },
    async lookupRegions({ advertiserId, creativeId }) {
      assert.equal(advertiserId, 'AR1');
      calls.push(creativeId);
      return [{ regionId: 2840, firstShown: null, lastShown }];
    },
  };

  assert.equal((await runScan({ store, client, now, log: () => {}, maxDetails: 30 })).status, 'ok');
  assert.equal(calls.length, 32);
  assert.equal(calls[0], first.id);
  assert.ok(calls.slice(1, 16).every(id => id.startsWith(first.id + '-')));
  assert.equal(calls[16], second.id);
  assert.ok(calls.slice(17).every(id => id.startsWith(second.id + '-')));
  const pending = store.creativesNeedingRegions(60, { now: now() });
  assert.equal(pending.length, 3);
  assert.equal(store.listAdsForProfile(id, { q: 'first.com' })[0].regions[0].iso, 'US');
});

test('a creative detail block stops all further requests', async t => {
  const { createStore } = await import('../src/store.js');
  const root = await mkdtemp(join(tmpdir(), 'atc-detail-blocked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root);
  const { id } = store.addProfile('Dai');
  const first = store.addWatch(id, 'first.com');
  store.addWatch(id, 'second.com');
  const calls = [];
  const client = {
    async rpc(method) {
      calls.push(method);
      assert.equal(method, 'SearchService/SearchCreatives');
      return { ads: [{ creativeId: 'CR1', advertiserId: 'AR1', lastShown: now().toISOString() }] };
    },
    async lookupRegions(ids) {
      calls.push(ids);
      throw new BlockedError('Bị chặn');
    },
  };
  assert.equal((await runScan({ store, client, now, log: () => {} })).status, 'blocked');
  assert.deepEqual(calls, ['SearchService/SearchCreatives', { advertiserId: 'AR1', creativeId: 'CR1' }]);
  assert.equal(store.getAds(first.id).ads.CR1.creativeId, 'CR1');
  assert.equal(store.getSummary(id, now()).lastScan.status, 'blocked');
});

test('a missing country response is retried next scan while a confirmed empty result is cached', async t => {
  const { createStore } = await import('../src/store.js');
  const root = await mkdtemp(join(tmpdir(), 'atc-detail-missing-'));
  const store = createStore(root);
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  store.addWatch(store.addProfile('Dai').id, 'site.com');
  let detailCalls = 0;
  let date = 22;
  const client = {
    async rpc(method) {
      assert.equal(method, 'SearchService/SearchCreatives');
      return { ads: [{ creativeId: date === 22 ? 'CR0' : 'CR1', advertiserId: 'AR1', lastShown: '2026-11-10T02:00:00Z' }] };
    },
  };
  const lookupRegions = async () => ++detailCalls === 1 ? null : [];
  for (; date <= 25; date++) {
    if (date === 23) client.lookupRegions = lookupRegions;
    const result = await runScan({ store, client, now: () => new Date(`2026-11-${date}T02:00:00Z`), log: () => {} });
    assert.equal(result.status, 'ok');
  }
  assert.equal(detailCalls, 2);
});

test('region lookups stop for the scan after 3 consecutive empty results', async () => {
  const { runScan: scan } = await import('../src/scanner.js');
  let lookups = 0;
  const pending = Array.from({ length: 10 }, (_, i) => ({ creativeId: `CR${i}`, advertiserId: 'AR1' }));
  const store = {
    allWatches: () => [{ id: 'w', type: 'domain', value: 'w.com' }], getAds: () => null,
    mergeAds: (watch, ads) => ({ file: { ads: {} }, newIds: [] }), appendScanLog: () => 1,
    creativesNeedingRegions: () => pending, setCreativeRegions: () => {}, imagesDir: () => '/tmp',
    recordGroupSnapshots: () => {}, setAdImage: () => {},
  };
  const client = { async rpc() { return { ads: [], nextToken: null }; }, async lookupRegions() { lookups++; return null; }, async captureImage() { return null; }, async close() {} };
  await scan({ store, client, log: () => {} });
  assert.equal(lookups, 3);
});
