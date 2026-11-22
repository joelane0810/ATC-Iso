import assert from 'node:assert/strict';
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
const { withLock } = await import('../src/lock.js');

const now = () => new Date('2026-11-22T02:00:00Z');
const first = { id: 'first', type: 'domain', value: 'first.example' };
const second = { id: 'second', type: 'domain', value: 'second.example' };

function setup(respond, { watches = [first], previous = [] } = {}) {
  const files = new Map();
  if (previous.length) files.set(first.id, { ads: Object.fromEntries(previous.map(id => [id, {}])) });
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
        file.ads[ad.creativeId] = ad;
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
      return destNoExt + '.png';
    },
  };
  return { scan: () => runScan({ store, client, now, log: () => {} }), files, logs, requests, captures, images };
}

const page = (ids, nextToken) => ({ ads: ids.map(creativeId => ({ creativeId })), nextToken });

test('first scan stops after five pages', async () => {
  const run = setup((req, n) => page(['CR' + n], String(n)));
  assert.deepEqual(await run.scan(), { status: 'ok', watched: 1, newAds: 5 });
  assert.deepEqual(run.requests.map(req => req.pageToken), [null, '1', '2', '3', '4']);
  assert.equal(run.captures.length, 5);
  assert.deepEqual(run.images[0], [first.id, 'CR1', 'images/CR1.png']);
  assert.equal(run.logs[0].status, 'ok');
});

test('later scan stops on a page with no new ads', async () => {
  const run = setup((req, n) => page(n === 1 ? ['CRnew', 'CRold'] : ['CRold'], String(n)), { previous: ['CRold'] });
  assert.deepEqual(await run.scan(), { status: 'ok', watched: 1, newAds: 1 });
  assert.equal(run.requests.length, 2);
  assert.deepEqual(run.captures, ['CRnew']);
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
  assert.equal(await withLock(path, () => 43), 43);
});
