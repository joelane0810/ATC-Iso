import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createStore } from '../src/store.js';
import { createDomainReader, extractDomain } from '../src/domain-ocr.js';
import { backfillDomains } from '../src/domain-backfill.js';

test('extractDomain reads OCR text and breaks frequency ties by first appearance', () => {
  for (const [text, expected] of [
    ['Sponsored / ® fitcamx.com 5 / Vehicle...', 'fitcamx.com'],
    ['Evry Jewels /  / ® www.evryjewels.com/', 'evryjewels.com'],
    ['© trungtamdienlanhcnc.com / www.trungtamdienlanhcnc.com/', 'trungtamdienlanhcnc.com'],
    ['google.com', null],
    ['gstatic.com / ads.doubleclick.net / yOuTube.com / tpc.googlesyndication.com / google.co.uk', null],
    ['®FitCamX .com / another.org / fitcamx.com / another.org', 'fitcamx.com'],
    ['first.com / first.com / later.net / www.later.net/ / later.net', 'later.net'],
  ]) assert.equal(extractDomain(text), expected);
});

const fixture = fileURLToPath(new URL('./fixtures/ocr-sample.png', import.meta.url));
test('Tesseract reads the local sample', async t => {
  if (!existsSync(fixture)) return t.skip('Thiếu ảnh mẫu.');
  try {
    import.meta.resolve('tesseract.js');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return t.skip('Chưa cài Tesseract.');
  }
  const reader = await createDomainReader();
  try {
    assert.equal(await reader.read(fixture), 'fitcamx.com');
  } finally {
    await reader.close();
  }
});

const at = new Date('2026-11-22T14:00:00Z');
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'atc-ocr-'));
  const store = createStore(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'AR123');
  const ad = { creativeId: 'CR1', advertiserId: 'AR123', firstShown: at.toISOString(),
    lastShown: at.toISOString(), imageUrl: 'https://example.com/1.png' };
  return { id, store, watch, ad };
}

test('OCR updates all watch observations and groups and survives later scans', t => {
  const { id, store, watch, ad } = setup(t);
  const regional = store.addWatch(id, 'AR123', 2840);
  store.mergeAds(watch, [ad], at);
  store.mergeAds(regional, [ad], at);
  assert.equal(store.setCreativeDomain(ad.creativeId, 'fitcamx.com'), true);
  assert.equal(store.setCreativeDomain(ad.creativeId, 'other.com'), false);
  store.mergeAds(watch, [{ ...ad, domain: null }], at);

  for (const entry of [watch, regional]) {
    assert.equal(store.getAds(entry.id).ads.CR1.domain, 'fitcamx.com');
  }
  const summary = store.getSummary(id, { now: at });
  assert.equal(summary.watches.length, 2);
  assert.ok(summary.watches.every(entry => entry.groups[0].key === 'fitcamx.com'));
  assert.ok(store.suggest('fitcamx').some(entry => entry.value === 'fitcamx.com'));
});

test('backfill uses one reader, prevents concurrent runs and retries misses after seven days', async t => {
  const { store, watch, ad } = setup(t);
  store.mergeAds(watch, [ad, { ...ad, creativeId: 'CR2', imageUrl: 'https://example.com/2.png' }], at);
  const calls = [];
  const logs = [];
  let opened = 0;
  let closed = 0;
  const options = {
    store, now: () => at, log: message => logs.push(message),
    wait: async ms => calls.push(ms),
    fetchImageResponse: async url => {
      calls.push(url);
      return new Response(url.at(-5));
    },
    createReader: async () => {
      opened++;
      return {
        read: async image => image.toString() === '1' ? 'fitcamx.com' : null,
        close: async () => { closed++; },
      };
    },
  };
  const work = backfillDomains(options);
  assert.equal(await backfillDomains(options), undefined);
  assert.deepEqual(await work, { attempted: 2, found: 1 });
  assert.deepEqual(calls, ['https://example.com/1.png', 300, 'https://example.com/2.png']);
  assert.deepEqual([opened, closed], [1, 1]);
  assert.match(logs.at(-1), /1\/2/);
  assert.equal(store.getAds(watch.id).ads.CR1.domain, 'fitcamx.com');
  assert.equal(store.getAds(watch.id).ads.CR2.domain ?? null, null);
  assert.deepEqual(await backfillDomains(options), { attempted: 0, found: 0 });
  assert.deepEqual(await backfillDomains({ ...options, now: () => new Date('2026-11-29T14:00:00Z') }),
    { attempted: 1, found: 0 });
});

test('backfill stops when the image server blocks requests', async t => {
  const { store, watch, ad } = setup(t);
  store.mergeAds(watch, [ad, { ...ad, creativeId: 'CR2' }], at);
  const result = await backfillDomains({
    store, now: () => at, log: () => {},
    fetchImageResponse: async () => new Response('', { status: 429 }),
    createReader: async () => assert.fail('Không đọc ảnh khi bị chặn.'),
    wait: async () => assert.fail('Không xử lý thêm ảnh khi bị chặn.'),
  });
  assert.deepEqual(result, { attempted: 1, found: 0 });
});

test('scan reads saved images and downloads missing images with the existing client', async t => {
  const { runScan } = await import('../src/scanner.js');
  const { store, watch, ad } = setup(t);
  store.mergeAds(watch, [ad, { ...ad, creativeId: 'CR2' }], at);
  writeFileSync(join(store.imagesDir(), 'CR1.png'), 'local');
  store.setAdImage(watch.id, 'CR1', 'images/CR1.png');

  const captures = [];
  let closed = false;
  const client = {
    rpc: async () => ({ '1': [] }),
    async captureImage(creative, dest) {
      captures.push(creative.creativeId);
      const path = dest + '.png';
      writeFileSync(path, 'remote');
      return path;
    },
  };
  const result = await runScan({
    store, client, now: () => at, log: () => {},
    createReader: async () => ({
      read: async input => input.toString() === 'local' ? 'saved.com' : 'downloaded.com',
      close: async () => { closed = true; },
    }),
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(captures, ['CR2']);
  assert.equal(closed, true);
  const { ads } = store.getAds(watch.id);
  assert.equal(ads.CR1.domain, 'saved.com');
  assert.equal(ads.CR2.domain, 'downloaded.com');
  assert.equal(ads.CR2.image, 'images/CR2.png');
});

test('backfill reads domains from saved preview snapshots once, including app-store ads', async t => {
  const { store, watch, ad } = setup(t);
  const textAd = { ...ad, creativeId: 'CR7', imageUrl: null, previewUrl: null, format: 'text' };
  const appAd = { ...ad, creativeId: 'CR8', imageUrl: null, previewUrl: null, format: 'video' };
  store.mergeAds(watch, [textAd, appAd], at);
  writeFileSync(join(store.imagesDir(), 'CR7.png'), 'Sponsored beehoneyspa.com');
  writeFileSync(join(store.imagesDir(), 'CR8.png'), 'Physics Stick Simulator Google Play');
  store.setAdImage(watch.id, 'CR7', 'images/CR7.png');
  store.setAdImage(watch.id, 'CR8', 'images/CR8.png');
  const { extractDomain, extractAppStore } = await import('../src/domain-ocr.js');
  const options = {
    store, now: () => at, log: () => {}, wait: async () => {},
    createReader: async () => ({
      read: async () => assert.fail('dùng readSnapshot cho ảnh chụp'),
      readSnapshot: async input => extractDomain(input.toString()) ?? extractAppStore(input.toString()),
      close: async () => {},
    }),
  };
  assert.deepEqual(await backfillDomains(options), { attempted: 2, found: 2 });
  assert.equal(store.getAds(watch.id).ads.CR7.domain, 'beehoneyspa.com');
  assert.equal(store.getAds(watch.id).ads.CR8.domain, 'play.google.com');
  assert.deepEqual(await backfillDomains(options), { attempted: 0, found: 0 });
});

test('normalizeOcrDomain fixes OCR slips using known domains and rejects fake endings', async () => {
  const { normalizeOcrDomain } = await import('../src/domain-ocr.js');
  assert.equal(normalizeOcrDomain('bechoneyspa.com', ['beehoneyspa.com']), 'beehoneyspa.com');
  assert.equal(normalizeOcrDomain('shop.example.con', []), 'shop.example.com');
  assert.equal(normalizeOcrDomain('watch.on', []), null);
  assert.equal(normalizeOcrDomain('viofo.com', ['abacus.ai']), 'viofo.com');
  assert.equal(normalizeOcrDomain('cnn.vn', []), 'cnn.vn');
  assert.equal(normalizeOcrDomain(null, []), null);
});
