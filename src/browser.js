import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { BlockedError, isBlockedResponse, RPC_BASE } from './atc.js';

const landingUrl = 'https://adstransparency.google.com/?region=anywhere';
const blockedMessage = 'Google đã chặn lượt quét';
const previewTimeout = 8_000;
const imageExtensions = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif'],
  ['image/bmp', '.bmp'],
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
  ['image/tiff', '.tiff'],
]);
const rpcTimeout = 30_000;

function responseMetadata(response) {
  const headers = response.headers();
  const url = response.url();
  const location = headers.location;
  return {
    status: response.status(),
    url,
    redirectedTo: location ? new URL(location, url).href : '',
    contentType: headers['content-type'],
  };
}

function assertUnblocked({ redirectedTo, ...response }) {
  if (isBlockedResponse(response) || isBlockedResponse({ url: redirectedTo })) {
    throw new BlockedError(blockedMessage);
  }
}

// These functions are evaluated in Chrome.
export function installPreview({ parentId, callback, src }) {
  const parent = document.createElement('div');
  parent.id = parentId;
  parent.style.width = 'max-content';
  document.body.append(parent);
  window[callback] = payload => {
    const html = typeof payload === 'string' ? payload : payload?.html;
    if (typeof html === 'string' && html.trim()) parent.innerHTML = html;
  };
  const script = document.createElement('script');
  script.src = src;
  document.body.append(script);
}

export function hasVisiblePreview({ parentId, videoRequired }) {
  const root = parentId ? document.getElementById(parentId) : document.body;
  if (!root) return false;
  const visible = element => {
    const style = getComputedStyle(element);
    return style.visibility === 'visible' && style.opacity !== '0'
      && [...element.getClientRects()].some(rect => rect.width && rect.height);
  };
  const images = [...root.querySelectorAll('img')].filter(visible);
  if (images.some(image => image.complete && image.naturalWidth > 0)) return true;
  const videos = [...root.querySelectorAll('video')].filter(visible);
  if (videoRequired || videos.length) {
    return videos.some(video => video.readyState >= 2 && video.videoWidth && video.videoHeight);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || !visible(node.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if ([...range.getClientRects()].some(rect => rect.width && rect.height)) return true;
  }
  return false;
}

async function frameInPreview(frame, page, parentId) {
  const parent = frame.parentFrame();
  if (!parent) return false;
  const element = await frame.frameElement();
  try {
    const visible = await element.evaluate((iframe, id) => {
      const rect = iframe.getBoundingClientRect();
      const style = getComputedStyle(iframe);
      return rect.width && rect.height && style.visibility === 'visible' && style.opacity !== '0'
        && (!id || document.getElementById(id)?.contains(iframe));
    }, parent === page.mainFrame() ? parentId : null);
    return visible && (parent === page.mainFrame() || await frameInPreview(parent, page, parentId));
  } finally {
    await element.dispose();
  }
}

async function waitForPreview(page, parentId, format, signal) {
  const options = { parentId, videoRequired: format === 'video' };
  while (!signal.aborted) {
    if (await page.evaluate(hasVisiblePreview, options)) return;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        if (await frameInPreview(frame, page, parentId) &&
            (frame.url() !== 'about:blank' ||
              await frame.evaluate(hasVisiblePreview, { ...options, parentId: null }))) return;
      } catch (error) {
        if (!/detached|context was destroyed/i.test(error.message)) throw error;
      }
    }
    await delay(100, undefined, { signal });
  }
}

async function renderPreview(context, previewUrl, format, path) {
  const url = new URL(previewUrl);
  assertUnblocked({ url: url.href });
  if (url.protocol !== 'https:') throw new Error('URL xem trước không hợp lệ');
  const parentId = url.searchParams.get('htmlParentId') || 'atc-preview';
  const callback = url.searchParams.get('responseCallback') || 'atcRenderPreview';
  for (const [name, value] of Object.entries({ htmlParentId: parentId, responseCallback: callback })) {
    if (!url.searchParams.has(name)) {
      url.search += (url.search ? '&' : '?') + name + '=' + encodeURIComponent(value);
    } else if (!url.searchParams.get(name)) {
      url.searchParams.set(name, value);
    }
  }
  url.hash = '';

  const page = await context.newPage();
  const deadline = performance.now() + previewTimeout;
  const remaining = () => Math.max(1, deadline - performance.now());
  const controller = new AbortController();
  let loaded;
  const firstScript = new Promise(resolve => { loaded = resolve; });
  let interrupt;
  const interrupted = new Promise((_, reject) => { interrupt = reject; });
  page.on('response', async response => {
    try {
      const metadata = responseMetadata(response);
      let request = response.request();
      while (request.redirectedFrom()) request = request.redirectedFrom();
      const script = request.url() === url.href;
      assertUnblocked({ ...metadata, contentType: script ? metadata.contentType : '' });
      if (!script || (metadata.status >= 300 && metadata.status < 400)) return;
      if (!response.ok()) throw new Error(`Tải nội dung xem trước thất bại (${metadata.status})`);
      assertUnblocked({ text: await response.text() });
      loaded();
    } catch (error) {
      interrupt(error);
    }
  });
  try {
    return await Promise.race([
      interrupted,
      delay(previewTimeout, undefined, { signal: controller.signal }).then(() => {
        throw new Error('Hết thời gian chờ nội dung xem trước');
      }),
      (async () => {
        await page.goto('about:blank', { timeout: remaining() });
        await page.evaluate(installPreview, { parentId, callback, src: url.href });
        await firstScript;
        await waitForPreview(page, parentId, format, controller.signal);
        await page.locator(`[id=${JSON.stringify(parentId)}]`).screenshot({ path, timeout: remaining() });
        return path;
      })(),
    ]);
  } finally {
    controller.abort();
    await page.close();
  }
}

async function captureDirectImage(context, imageUrl, destNoExt) {
  const deadline = performance.now() + previewTimeout;
  let url = imageUrl;
  for (let redirects = 0; redirects <= 10; redirects++) {
    assertUnblocked({ url });
    const response = await context.request.get(url, {
      timeout: Math.max(1, deadline - performance.now()), maxRedirects: 0,
    });
    try {
      const metadata = responseMetadata(response);
      assertUnblocked(metadata);
      if (metadata.status >= 300 && metadata.status < 400 && metadata.redirectedTo) {
        url = metadata.redirectedTo;
        continue;
      }
      if (!response.ok()) throw new Error(`Tải ảnh xem trước thất bại (${metadata.status})`);
      const contentType = metadata.contentType?.split(';')[0].trim().toLowerCase();
      const extension = imageExtensions.get(contentType);
      const body = await response.body();
      assertUnblocked({ text: body.subarray(0, 1024).toString() });
      if (!extension) throw new Error('Định dạng ảnh xem trước chưa được hỗ trợ');
      const path = destNoExt + extension;
      await writeFile(path, body);
      return path;
    } finally {
      await response.dispose();
    }
  }
  throw new Error('Ảnh xem trước chuyển hướng quá nhiều lần');
}

export async function openChromeClient({
  profileDir, minDelayMs = 8000, jitterMs = 4000, headless = false,
  launch = (dir, options) => chromium.launchPersistentContext(dir, options), log = console.error,
}) {
  const context = await launch(profileDir, { channel: 'chrome', headless });
  let page;
  let blocked = false;
  const isSorry = () => isBlockedResponse({ url: page.url() });

  try {
    page = context.pages()[0] ?? await context.newPage();
    page.on('response', response => {
      const request = response.request();
      if (!request.isNavigationRequest() || request.resourceType() !== 'document') return;
      const { status, url, redirectedTo } = responseMetadata(response);
      blocked ||= isBlockedResponse({ status, url }) || isBlockedResponse({ url: redirectedTo });
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && isBlockedResponse({ url: frame.url() })) blocked = true;
    });
    const response = await page.goto(landingUrl, { waitUntil: 'domcontentloaded', timeout: rpcTimeout });
    blocked ||= isSorry() || response?.status() === 429;
    if (!blocked) {
      blocked = await page.evaluate(() => Boolean(document.querySelector(
        '#captcha-form, #recaptcha, .g-recaptcha, form[action*="/sorry/"], iframe[src*="/recaptcha/"]',
      )) || /unusual traffic from your computer network/i.test(document.body?.innerText ?? ''));
    }
    if (!blocked && response && !response.ok()) throw new Error(`Google trả về lỗi ${response.status()}`);
  } catch (error) {
    if (blocked || (page && isSorry())) blocked = true;
    else {
      await context.close();
      throw error;
    }
  }
  if (blocked) {
    await context.close();
    throw new BlockedError(blockedMessage);
  }

  let nextRpcAt = 0;
  let queue = Promise.resolve();

  async function request(method, req) {
    if (blocked || isSorry()) throw new BlockedError(blockedMessage);
    await delay(Math.max(0, nextRpcAt - performance.now()));
    if (blocked || isSorry()) throw new BlockedError(blockedMessage);
    nextRpcAt = performance.now() + minDelayMs + Math.random() * jitterMs;
    try {
      const response = await page.evaluate(async ({ url, req, timeout }) => {
        const response = await fetch(url, {
          method: 'POST',
          body: new URLSearchParams({ 'f.req': JSON.stringify(req) }),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeout),
        });
        const contentType = response.headers.get('content-type') ?? '';
        const redirected = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
        const html = /^(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i.test(contentType);
        return {
          status: response.status, url: response.url, contentType, redirected,
          text: response.ok && !redirected && !html && response.status !== 429
            ? await response.text()
            : '',
        };
      }, { url: `${RPC_BASE}/${method}?authuser=`, req, timeout: rpcTimeout });
      if (response.redirected || blocked || isSorry()) throw new BlockedError(blockedMessage);
      assertUnblocked(response);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Google trả về lỗi ${response.status}`);
      }
      return JSON.parse(response.text.replace(/^\)\]\}'[^\S\n]*\r?\n/, ''));
    } catch (error) {
      if (error instanceof BlockedError || blocked || isSorry()) {
        blocked = true;
        throw new BlockedError(blockedMessage);
      }
      throw error;
    }
  }

  return {
    rpc(method, req) {
      const pending = queue.then(() => request(method, req));
      queue = pending.catch(() => {});
      return pending;
    },

    async captureImage(ad, destNoExt) {
      if (blocked || isSorry()) throw new BlockedError(blockedMessage);
      try {
        if (ad.imageUrl) {
          await mkdir(dirname(destNoExt), { recursive: true });
          return await captureDirectImage(context, ad.imageUrl, destNoExt);
        }
        if (ad.previewUrl) {
          await mkdir(dirname(destNoExt), { recursive: true });
          return await renderPreview(context, ad.previewUrl, ad.format, destNoExt + '.png');
        }
        return null;
      } catch (error) {
        if (error instanceof BlockedError || blocked || isSorry()) {
          blocked = true;
          throw new BlockedError(blockedMessage);
        }
        log(`Không chụp được ảnh xem trước ${ad.creativeId ?? ''}: ${error.message}`);
        return null;
      }
    },

    close: () => context.close(),
  };
}
