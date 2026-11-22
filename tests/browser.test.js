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

function previewPage({ block = false, format, url = previewUrl, iframe = false }) {
  const page = new EventEmitter();
  const parent = { style: {}, innerHTML: '' };
  const window = {};
  const video = { readyState: 0, videoWidth: 0, videoHeight: 0, getClientRects: () => [{ width: 30, height: 10 }] };
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
  const mainFrame = {};
  const childFrame = {
    parentFrame: () => mainFrame,
    url: () => 'https://example.com/ad',
    async frameElement() {
      const element = { getBoundingClientRect: () => ({ width: checks > 1 ? 30 : 0, height: 10 }) };
      return {
        evaluate: (fn, id) => Function('document', 'getComputedStyle', 'element', 'id',
          'return (' + fn.toString() + ')(element, id)')(
          { getElementById: () => ({ contains: node => node === element }) },
          () => ({ visibility: 'visible' }), element, id,
        ),
        dispose: async () => {},
      };
    },
  };
  Object.assign(page, {
    goto: async () => {},
    mainFrame: () => mainFrame,
    frames: () => iframe ? [mainFrame, childFrame] : [],
    close: async () => { fixture.closed = true; },
    locator: () => ({ screenshot: async () => {
      assert.equal(checks, 2);
      fixture.screenshots++;
    } }),
    async evaluate(fn, args) {
      if (fn === installPreview) {
        fixture.scriptUrl = new URL(args.src);
        assert.equal(args.parentId, fixture.scriptUrl.searchParams.get('htmlParentId'));
        assert.equal(args.callback, fixture.scriptUrl.searchParams.get('responseCallback'));
        assert.ok(args.parentId);
        assert.ok(args.callback);
        const scriptUrl = new URL(url);
        scriptUrl.searchParams.set('htmlParentId', args.parentId);
        scriptUrl.searchParams.set('responseCallback', args.callback);
        assert.deepEqual([...fixture.scriptUrl.searchParams], [...scriptUrl.searchParams]);
        const callback = JSON.stringify(args.callback);
        const script = format === 'video'
          ? `window[${callback}]({html:"<video></video>"});`
          : `window[${callback}]("<span>Quảng cáo mẫu</span>");`;
        Function('document', 'window', 'args', '(' + fn.toString() + ')(args)')(document, window, args);
        parent.innerHTML = '<iframe></iframe>';
        page.emit('response', response({ url: args.src, body: block ? '<html>Blocked</html>' : script }));
        if (!block) Function('window', script)(window);
        return;
      }
      assert.equal(fn, hasVisiblePreview);
      checks++;
      if (iframe) return false;
      if (checks > 1) Object.assign(video, { readyState: 2, videoWidth: 100, videoHeight: 60 });
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

test('content.js receives missing parameters and preserves existing query values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atc-preview-params-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const query of ['creativeId=123&uiFeatures=12,54', 'creativeId=123&htmlParentId=existing']) {
    const url = new URL('?' + query, previewUrl);
    const preview = previewPage({ format: 'text', url });
    const client = await chrome({ preview: preview.page }).open();
    const dest = join(dir, 'CR');
    assert.equal(await client.captureImage({ format: 'text', previewUrl: url.href }, dest), dest + '.png');
    for (const [key, value] of url.searchParams) {
      assert.equal(preview.scriptUrl.searchParams.get(key), value);
    }
    assert.equal(preview.screenshots, 1);
  }
});

test('preview waits for a nonzero iframe without requiring a video element', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atc-preview-frame-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preview = previewPage({ format: 'video', iframe: true });
  const client = await chrome({ preview: preview.page }).open();
  const dest = join(dir, 'CR');
  assert.equal(await client.captureImage({ format: 'video', previewUrl }, dest), dest + '.png');
  assert.equal(preview.screenshots, 1);
});
