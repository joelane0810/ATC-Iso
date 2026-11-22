import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BlockedError } from '../src/atc.js';
import { hasVisiblePreview, installPreview, openChromeClient } from '../src/browser.js';

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
    newPage: async () => preview,
    request: { get: async (url, options) => {
      calls.push(url);
      assert.equal(options.maxRedirects, 0);
      return direct;
    } },
  };
  return {
    calls, open: () => openChromeClient({ launch: async () => context, minDelayMs: 0, jitterMs: 0 }),
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

function previewPage({ block = false, format, url = previewUrl }) {
  const page = new EventEmitter();
  const parent = { style: {}, innerHTML: '' };
  const window = {};
  const video = { readyState: 0, videoWidth: 0, videoHeight: 0, getClientRects: () => [{ width: 30, height: 10 }] };
  const callback = JSON.stringify(new URL(url).searchParams.get('responseCallback'));
  const script = format === 'video'
    ? `window[${callback}]({html:"<video></video>"});`
    : `window[${callback}]("<span>Quảng cáo mẫu</span>");`;
  let checks = 0;
  const fixture = {
    page, screenshots: 0, closed: false,
    get checks() { return checks; },
  };
  const document = {
    createElement: name => name === 'div' ? parent : {},
    body: { append() {} },
    getElementById: () => parent,
    createTreeWalker: () => ({
      nextNode: () => checks > 1 && parent.innerHTML.includes('Quảng cáo mẫu'),
      currentNode: { textContent: 'Quảng cáo mẫu', parentElement: { getClientRects: () => [{ width: 30, height: 10 }] } },
    }),
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [{ width: 30, height: 10 }] }),
  };
  parent.querySelectorAll = tag => tag === 'video' && parent.innerHTML.includes('<video>') ? [video] : [];
  Object.assign(page, {
    goto: async () => {},
    frames: () => [],
    close: async () => { fixture.closed = true; },
    locator: () => ({ screenshot: async () => {
      assert.equal(checks, 2);
      fixture.screenshots++;
    } }),
    async evaluate(fn, args) {
      if (fn === installPreview) {
        Function('document', 'window', 'args', '(' + fn.toString() + ')(args)')(document, window, args);
        parent.innerHTML = '<iframe></iframe>';
        page.emit('response', response({ url, body: block ? '<html>Blocked</html>' : script }));
        if (!block) Function('window', script)(window);
        return;
      }
      assert.equal(fn, hasVisiblePreview);
      if (++checks > 1) Object.assign(video, { readyState: 2, videoWidth: 100, videoHeight: 60 });
      return Function('document', 'NodeFilter', 'getComputedStyle', 'args', 'return (' + fn.toString() + ')(args)')(
        document, { SHOW_TEXT: 4 }, () => ({ visibility: 'visible' }), args,
      );
    },
  });
  return fixture;
}

test('content.js HTML blocks the scan before rendering', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atc-preview-block-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preview = previewPage({ block: true, format: 'text' });
  const client = await chrome({ preview: preview.page }).open();
  await assert.rejects(client.captureImage({ format: 'text', previewUrl }, join(dir, 'CR')), BlockedError);
  assert.equal(preview.checks, 0);
  assert.equal(preview.closed, true);
});

test('content.js text and video callbacks wait for visible text or a video frame', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atc-preview-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = JSON.parse(await readFile(new URL('./fixtures/search-creatives.json', import.meta.url)));
  const url = fixture[1].find(ad => ad[4] === 1)[3][1][4];
  assert.equal(new URL(url).pathname, '/ads/preview/content.js');
  for (const format of ['text', 'video']) {
    const preview = previewPage({ format, url });
    const client = await chrome({ preview: preview.page }).open();
    assert.equal(await client.captureImage({ format, previewUrl: url }, join(dir, 'CR')), join(dir, 'CR.png'));
    assert.equal(preview.screenshots, 1);
    assert.equal(preview.closed, true);
  }
});
