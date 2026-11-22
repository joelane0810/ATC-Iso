import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createStore } from '../src/store.js';
import { backfillDomains } from '../src/domain-backfill.js';
import { extractPreviewDomain, isPreviewScript } from '../src/preview-domain.js';

const preview = 'https://displayads-formats.googleusercontent.com/ads/preview/content.js?client=x&creativeId=1';

test('extractPreviewDomain reads the visible URL from escaped preview scripts', () => {
  assert.equal(extractPreviewDomain("x\\x3d{google_ait_url: 'https://googleads.g.doubleclick.net/x',visible_url: 'giadungvn.top',destination_url: 'https://www.giadungvn.top/a?b\\x3dc'}"), 'giadungvn.top');
  assert.equal(extractPreviewDomain("visible_url: 'www.PuPrime.com/',"), 'puprime.com');
  assert.equal(extractPreviewDomain("visible_url: '',destination_url: 'https://shop.example.co.uk/x'"), 'shop.example.co.uk');
  assert.equal(extractPreviewDomain("visible_url: 'www.google.com'"), null);
  assert.equal(extractPreviewDomain('nothing here'), null);
  assert.equal(isPreviewScript(preview), true);
  assert.equal(isPreviewScript('https://tpc.googlesyndication.com/archive/simgad/1'), false);
});

test('backfill fills text-ad domains from preview scripts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'atc-preview-'));
  const store = createStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const at = new Date('2026-11-22T14:00:00Z');
  const { id } = store.addProfile('Dai');
  const watch = store.addWatch(id, 'AR123');
  store.mergeAds(watch, [
    { creativeId: 'CR1', advertiserId: 'AR123', previewUrl: preview, firstShown: at.toISOString(), lastShown: at.toISOString() },
    { creativeId: 'CR2', advertiserId: 'AR123', previewUrl: preview + '2', firstShown: at.toISOString(), lastShown: at.toISOString() },
  ], at);
  const fetched = [];
  const result = await backfillDomains({
    store, now: () => at, log: () => {}, wait: async () => {},
    fetchPreviewResponse: async url => { fetched.push(url); return new Response(url.endsWith('2') ? 'no url' : "visible_url: 'cruva.com'"); },
    createReader: async () => { throw new Error('không cần đọc ảnh'); },
  });
  assert.deepEqual(result, { attempted: 2, found: 1 });
  assert.equal(fetched.length, 2);
  assert.equal(store.getAds(watch.id).ads.CR1.domain, 'cruva.com');
  const [ad] = store.listAdsForProfile(id, {}, at).filter(entry => entry.creativeId === 'CR1');
  assert.equal(ad.domainSource, 'preview');
});

test('falls back to the most linked advertiser host, ignoring infrastructure', () => {
  const script = '<a href=\\"https://www.shop-healthypetz.com/x\\">www.shop-healthypetz.com</a> //rr3---sn-x.googlevideo.com/v //cdn.ampproject.org/a //cdn.ampproject.org/b this.top window.top //www.w3.org/2000/svg //www.w3.org/1999';
  assert.equal(extractPreviewDomain(script), 'shop-healthypetz.com');
  assert.equal(extractPreviewDomain('//once.com/x'), null);
});
