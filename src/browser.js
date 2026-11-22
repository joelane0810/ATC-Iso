import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { BlockedError, isBlockedResponse, RPC_BASE } from './atc.js';

const landingUrl = 'https://adstransparency.google.com/?region=anywhere';
const blockedMessage = 'Google đã chặn lượt quét';
const previewTimeout = 10_000;

async function renderPreview(context, previewUrl, path) {
  const url = new URL(previewUrl);
  const parentId = url.searchParams.get('htmlParentId');
  const callback = url.searchParams.get('responseCallback');
  if (!parentId || !callback || url.protocol !== 'https:') return null;

  const page = await context.newPage();
  const deadline = performance.now() + previewTimeout;
  try {
    await page.goto('about:blank', { timeout: previewTimeout });
    await page.evaluate(({ parentId, callback, src }) => {
      const parent = document.createElement('div');
      parent.id = parentId;
      parent.style.width = 'max-content';
      document.body.append(parent);
      window[callback] = payload => {
        if (typeof payload === 'string' && !parent.hasChildNodes()) parent.innerHTML = payload;
      };
      const script = document.createElement('script');
      script.src = src;
      document.body.append(script);
    }, { parentId, callback, src: url.href });
    const target = page.locator(`[id=${JSON.stringify(parentId)}]`).filter({
      has: page.locator('*'),
    });
    await target.screenshot({ path, timeout: Math.max(1, deadline - performance.now()) });
    return path;
  } finally {
    await page.close();
  }
}

export async function openChromeClient({
  profileDir, minDelayMs = 8000, jitterMs = 4000, headless = false,
}) {
  const context = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless });
  let page;
  let blocked = false;
  const isSorry = () => isBlockedResponse({ status: 0, url: page.url(), text: '' });

  try {
    page = context.pages()[0] ?? await context.newPage();
    const response = await page.goto(landingUrl, { waitUntil: 'domcontentloaded' });
    blocked = isSorry() || isBlockedResponse({
      status: response?.status() ?? 0, url: page.url(), text: '',
    });
  } catch (error) {
    if (page && isSorry()) {
      blocked = true;
    } else {
      await context.close();
      throw error;
    }
  }

  let nextRpcAt = 0;
  let queue = Promise.resolve();

  async function request(method, req) {
    if (blocked || isSorry()) throw new BlockedError(blockedMessage);
    await delay(Math.max(0, nextRpcAt - performance.now()));
    if (isSorry()) throw new BlockedError(blockedMessage);
    nextRpcAt = performance.now() + minDelayMs + Math.random() * jitterMs;
    try {
      const response = await page.evaluate(async ({ url, req }) => {
        const response = await fetch(url, {
          method: 'POST',
          body: new URLSearchParams({ 'f.req': JSON.stringify(req) }),
          redirect: 'manual',
        });
        return {
          status: response.status,
          url: response.url,
          text: await response.text(),
          redirected: response.type === 'opaqueredirect',
        };
      }, { url: `${RPC_BASE}/${method}?authuser=`, req });
      if (response.redirected || isBlockedResponse(response) || isSorry()) {
        throw new BlockedError(blockedMessage);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Google trả về lỗi ${response.status}`);
      }
      return JSON.parse(response.text.replace(/^\)\]\}'[^\S\n]*\r?\n/, ''));
    } catch (error) {
      if (error instanceof BlockedError || isSorry()) {
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
      try {
        if (ad.format === 'image' && ad.imageUrl) {
          const response = await context.request.get(ad.imageUrl, { timeout: previewTimeout });
          try {
            if (!response.ok()) return null;
            const contentType = response.headers()['content-type']?.split(';')[0];
            const extension = { 'image/jpeg': '.jpg', 'image/png': '.png' }[contentType];
            if (!extension) return null;
            const path = destNoExt + extension;
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, await response.body());
            return path;
          } finally {
            await response.dispose();
          }
        }
        if ((ad.format === 'text' || ad.format === 'video') && ad.previewUrl) {
          await mkdir(dirname(destNoExt), { recursive: true });
          return await renderPreview(context, ad.previewUrl, destNoExt + '.png');
        }
        return null;
      } catch {
        return null;
      }
    },

    close: () => context.close(),
  };
}
