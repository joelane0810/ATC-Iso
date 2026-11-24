import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSnapshotBackfill, createSnapshotter } from '../src/preview-snapshot.js';
import { createStore } from '../src/store.js';

const url = 'https://displayads-formats.googleusercontent.com/ad/content.js?htmlParentId=old&responseCallback=old&x=1&x=2';
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(3000, 1)]);

test('snapshotter captures rendered content and skips errors, empty results and timeouts', async () => {
  let mode = 'content';
  let closed = 0;
  let html;
  let routeHandler;
  const page = {
    async goto(address) {
      await routeHandler({ request: () => ({ url: () => address }), fulfill: ({ body }) => { html = body; }, continue() {}, abort() {} });
    },
    waitForFunction(fn, arg, options) {
      assert.equal(options.timeout, 12_000);
      const result = this.evaluate(fn, arg);
      if (!result) throw new Error('Timeout');
      return { jsonValue: () => result };
    },
    evaluate(fn, arg) {
      const target = { innerText: mode === 'content' ? 'Quảng cáo' : '', dataset: { sized: mode === 'empty' }, querySelector: () => null };
      const body = { innerText: ({ error: 'That’s an error', missing: '404. Not found', serverError: '500. Server error' })[mode] ?? '' };
      return runInNewContext('(' + fn.toString() + ')(arg)', { arg, document: { getElementById: () => target, body } });
    },
    frames: () => [],
    waitForTimeout: ms => assert.equal(ms, 1500),
    locator(selector) {
      assert.equal(selector, '#atc-preview');
      return { screenshot: () => png };
    },
  };
  const snapshotter = await createSnapshotter({
    launch(options) {
      assert.deepEqual(options, { channel: 'chrome', headless: true });
      return {
        newContext: () => ({
          routeWebSocket() {},
          route(pattern, handler) { routeHandler = handler; },
          newPage: () => page,
          close: () => { closed++; },
        }),
        close() {},
      };
    },
  });
  assert.deepEqual(await snapshotter.snapshot(url), png);
  assert.match(html, /x=1&amp;x=2&amp;htmlParentId=atc-preview&amp;responseCallback=atcPreviewReady/);
  assert.doesNotMatch(html, /htmlParentId=old|responseCallback=old/);
  for (const next of ['error', 'missing', 'serverError', 'empty', 'timeout']) {
    mode = next;
    assert.equal(await snapshotter.snapshot(url), null, next);
  }
  assert.equal(await snapshotter.snapshot('https://adstransparency.google.com/content.js'), null);
  assert.equal(closed, 6);
  await snapshotter.close();
});

test('backfill shares a browser, avoids overlapping runs, and saves an image readable by both lists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc-snapshot-'));
  const store = createStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'example.com');
  const at = '2026-11-22T14:00:00Z';
  const ad = { previewUrl: url, advertiserId: 'AR1', domain: 'example.com', format: 'text', firstShown: at, lastShown: at };
  store.mergeAds(watch, [{ ...ad, creativeId: 'CR1' }, { ...ad, creativeId: 'CR2' }], at);
  let launched = 0;
  let closed = 0;
  let calls = 0;
  const delays = [];
  const run = createSnapshotBackfill({
    store,
    pause: ms => delays.push(ms),
    open: () => {
      launched++;
      return {
        snapshot: () => ++calls === 1 ? png : null,
        close: () => { closed++; },
      };
    },
  });
  await Promise.all([run(), run()]);
  assert.equal(launched, 1);
  assert.equal(closed, 1);
  assert.deepEqual(delays, [300]);
  assert.deepEqual(await readFile(join(root, 'data/images/CR1.png')), png);
  assert.equal(store.listAdsForProfile(id).find(item => item.creativeId === 'CR1').image, 'images/CR1.png');
  assert.equal(store.getAds(watch.id).ads.CR2.image, null);
  const summary = store.getSummary(id, { now: at });
  assert.equal(summary.watches[0].groups[0].sampleAds.find(item => item.creativeId === 'CR1').image, 'images/CR1.png');
});


test('video previews give their YouTube cover image without a screenshot', async () => {
  const { extractVideoThumbnail } = await import('../src/preview-snapshot.js');
  assert.equal(extractVideoThumbnail('a \\x22https:\\/\\/i.ytimg.com\\/vi\\/s9-64Ptz6ZM\\/hqdefault.jpg\\x22'),
    'https://i.ytimg.com/vi/s9-64Ptz6ZM/hqdefault.jpg');
  assert.equal(extractVideoThumbnail('https://i9.ytimg.com/vi/l5JCMA68OKQ/mqdefault.jpg'), 'https://i.ytimg.com/vi/l5JCMA68OKQ/hqdefault.jpg');
  assert.equal(extractVideoThumbnail('no video here'), null);
});
