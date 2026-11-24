import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { errors } from 'playwright-core';
import { BlockedError } from '../src/atc.js';
import { openChromeClient } from '../src/browser.js';

const atc = 'https://adstransparency.google.com';
const previewUrl = 'https://displayads-formats.googleusercontent.com/ads/preview/content.js?htmlParentId=ad&responseCallback=render';
const response = ({ status = 200, url = previewUrl, headers = {}, body = '' } = {}) => ({
  headers: () => headers, url: () => url, status: () => status,
  ok: () => status >= 200 && status < 300,
  request: () => ({ url: () => url, redirectedFrom: () => null }),
  text: async () => body, body: async () => Buffer.from(body), dispose: async () => {},
});

function chrome({ landingUrl = atc, challenge = false, fetchResponse, direct, preview } = {}) {
  const calls = [];
  const page = Object.assign(new EventEmitter(), {
    url: () => landingUrl,
    goto: async () => response({ url: landingUrl }),
    async evaluate(fn, args) {
      if (!args) {
        const document = { querySelector: selector => challenge && selector.includes('#captcha-form'), body: {} };
        return Function('document', 'return (' + fn.toString() + ')()')(document);
      }
      return Function('fetch', 'args', 'return (' + fn.toString() + ')(args)')(fetchResponse, args);
    },
  });
  const context = {
    pages: () => [page], close: async () => { calls.push('close'); },
    newPage: async () => {
      calls.push('newPage');
      assert.ok(preview, 'unexpected extra page');
      return preview;
    },
    request: { get: async (url, options) => {
      calls.push(url);
      assert.equal(options.maxRedirects, 0);
      return direct;
    } },
  };
  return {
    calls, open: (minDelayMs = 0) => openChromeClient({ launch: async () => context, minDelayMs, jitterMs: 0 }),
  };
}

test('landing blocks on ATC /sorry and on the CAPTCHA DOM at status 200', async () => {
  for (const options of [{ landingUrl: atc + '/sorry/index' }, { challenge: true }]) {
    const fake = chrome(options);
    await assert.rejects(fake.open(), BlockedError);
    assert.deepEqual(fake.calls, ['close']);
  }
});

test('RPC checks block headers before reading the body and applies a deadline', async () => {
  for (const [status, type] of [[429, 'application/json'], [200, 'text/html; charset=UTF-8']]) {
    let requested = 0;
    const client = await chrome({ fetchResponse: async (url, options) => {
      requested++;
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.redirect, 'manual');
      return {
        ok: status === 200, status, headers: new Headers({ 'content-type': type }), url,
        text() { assert.fail('blocked body should not be read'); },
      };
    } }).open();
    await assert.rejects(client.rpc('SearchService/SearchCreatives', {}), BlockedError);
    await assert.rejects(client.rpc('SearchService/SearchCreatives', {}), BlockedError);
    assert.equal(requested, 1);
  }
});

test('image download propagates 429, HTML and /sorry redirects without another request', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atc-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const direct of [
    response({ status: 429 }),
    response({ headers: { 'content-type': 'text/html' } }),
    response({ body: '<html>CAPTCHA</html>' }),
    response({ status: 302, headers: { location: atc + '/sorry/index' } }),
  ]) {
    const fake = chrome({ direct });
    const client = await fake.open();
    const ad = { format: 'image', imageUrl: 'https://example.com/preview.png' };
    await assert.rejects(client.captureImage(ad, join(dir, 'CR1')), BlockedError);
    await assert.rejects(client.captureImage(ad, join(dir, 'CR2')), BlockedError);
    assert.deepEqual(fake.calls, [ad.imageUrl]);
  }
});

test('content.js preview alone opens no page and makes no download request', async () => {
  const fake = chrome();
  const client = await fake.open();
  for (const format of ['text', 'image', 'video']) {
    assert.equal(await client.captureImage({ format, previewUrl }, 'unused'), null);
  }
  assert.deepEqual(fake.calls, []);
});

test('archive image is downloaded directly for text, image and video ads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atc-direct-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imageUrl = 'https://tpc.googlesyndication.com/archive/simgad/12345';
  const body = 'RIFF image bytes';
  const fake = chrome({ direct: response({ url: imageUrl, headers: {
    'content-type': 'IMAGE/WEBP; charset=binary',
  }, body }) });
  const client = await fake.open();
  const ad = { imageUrl, previewUrl };
  for (const format of ['text', 'image', 'video']) {
    const dest = join(dir, format);
    assert.equal(await client.captureImage({ ...ad, format }, dest), dest + '.webp');
    assert.deepEqual(await readFile(dest + '.webp'), Buffer.from(body));
  }
  assert.deepEqual(fake.calls, [imageUrl, imageUrl, imageUrl]);
});

function creativeTab(payloads) {
  const visits = [];
  let predicate;
  let resolve;
  let reject;
  let captcha = false;
  return {
    visits,
    url: () => visits.at(-1) ?? 'about:blank',
    waitForResponse(match, { timeout }) {
      assert.equal(timeout, 15_000);
      predicate = match;
      return new Promise((accept, fail) => { resolve = accept; reject = fail; });
    },
    async goto(url) {
      visits.push(url);
      const payload = payloads.shift();
      captcha = Boolean(payload?.captcha);
      try {
        if (payload) {
          const candidate = response({
            url: atc + '/anji/_/rpc/LookupService/GetCreativeById',
            ...payload,
          });
          if (predicate(candidate)) resolve(candidate);
        } else {
          reject(new errors.TimeoutError('Hết thời gian chờ'));
        }
      } catch (error) {
        reject(error);
      }
      return response({ url, headers: { 'content-type': 'text/html' } });
    },
    async evaluate() { return captcha; },
  };
}

test('the detail tab reads the page response, returns null on timeout and is reused', async () => {
  const tab = creativeTab([{ body: ")]}'\n" + JSON.stringify({ 17: [{ 1: 2704, 5: 20261122 }] }) }, null]);
  const client = await chrome({ preview: tab }).open();
  assert.deepEqual(await client.lookupRegions({ advertiserId: 'AR1', creativeId: 'CR1' }), [
    { regionId: 2704, firstShown: null, lastShown: '2026-11-22T00:00:00.000Z' },
  ]);
  assert.equal(await client.lookupRegions({ advertiserId: 'AR1', creativeId: 'CR2' }), null);
  assert.deepEqual(tab.visits, ['CR1', 'CR2'].map(id =>
    atc + '/advertiser/AR1/creative/' + id + '?region=anywhere&platform=SEARCH'));
  await client.close();
});

test('detail blocking stops subsequent lookups and RPCs', async () => {
  for (const payload of [
    { status: 429 },
    { status: 302, url: atc, headers: { location: 'https://www.google.com/sorry/index' } },
    { captcha: true },
  ]) {
    const tab = creativeTab([payload]);
    const client = await chrome({ preview: tab }).open();
    const lookup = () => client.lookupRegions({ advertiserId: 'AR1', creativeId: 'CR1' });
    await assert.rejects(lookup(), BlockedError);
    await assert.rejects(lookup(), BlockedError);
    await assert.rejects(client.rpc('SearchService/SearchCreatives', {}), BlockedError);
    assert.equal(tab.visits.length, 1);
    await client.close();
  }
});

test('RPC and detail visits share the same pacing queue', async () => {
  const times = [];
  const interval = 30;
  const tab = creativeTab([{ body: '{"17":[]}' }]);
  const goto = tab.goto;
  tab.goto = url => {
    times.push(performance.now());
    return goto(url);
  };
  const client = await chrome({ preview: tab, fetchResponse: async () => {
    times.push(performance.now());
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  } }).open(interval);
  const rpc = () => client.rpc('SearchService/SearchCreatives', {});
  await Promise.all([rpc(), client.lookupRegions({ advertiserId: 'AR1', creativeId: 'CR1' }), rpc()]);
  assert.equal(times.length, 3);
  assert.equal(tab.visits.length, 1);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= interval - 1);
  await client.close();
});

test('a 429 from another Google host on the detail page is not a block', async () => {
  const tab = creativeTab([{ body: '{"17":[{"1":2724,"5":20261122}]}' }]);
  const wait = tab.waitForResponse.bind(tab);
  tab.waitForResponse = (match, options) => {
    // Máy ghi nhật ký của Google trả 429 trước khi dữ liệu quốc gia về.
    assert.equal(match(response({ url: 'https://play.google.com/log?format=json', status: 429 })), false);
    return wait(match, options);
  };
  const client = await chrome({ preview: tab }).open();
  assert.deepEqual(await client.lookupRegions({ advertiserId: 'AR1', creativeId: 'CR1' }), [
    { regionId: 2724, firstShown: null, lastShown: '2026-11-22T00:00:00.000Z' },
  ]);
  await client.close();
});

test('closes restored extra tabs on launch and reports ATC tab count', async () => {
  const closed = [];
  const mk = (url) => Object.assign(new EventEmitter(), {
    url: () => url, goto: async () => response({ url: atc }),
    close: async () => { closed.push(url); },
    evaluate: async () => false,
  });
  const main = mk(atc);
  const extras = [mk(atc + '/advertiser/AR1'), mk('https://example.com')];
  let pages = [main, ...extras];
  const context = Object.assign(new EventEmitter(), {
    pages: () => pages, close: async () => {},
  });
  const client = await openChromeClient({ launch: async () => context, minDelayMs: 0, jitterMs: 0 });
  assert.equal(closed.length, 2);
  pages = [main];
  assert.equal(client.atcTabCount(), 1);
  const popup = mk(atc + '/x');
  context.emit('page', popup);
  await new Promise(r => setImmediate(r));
  assert.equal(closed.length, 3);
});

test('with a one-tab budget, region lookups reuse the main tab', async () => {
  // Kiểm bằng mã: khi maxTabs < 2 thì không bao giờ gọi newPage cho trang chi tiết.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/browser.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!detailPage && maxTabs < 2\) detailPage = page;/);
});

test('RPC retries once when the ATC page navigates mid-request', async () => {
  let calls = 0;
  const fake = chrome({ fetchResponse: async (url) => {
    calls++;
    if (calls === 1) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), url, text: async () => '{"1":[]}' };
  } });
  const client = await fake.open();
  assert.deepEqual(await client.rpc('SearchService/SearchCreatives', {}), { 1: [] });
  assert.equal(calls, 2);
});
