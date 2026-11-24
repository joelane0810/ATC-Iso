import { chromium } from 'playwright-core';
import { isBlockedResponse } from './atc.js';
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const origin = 'https://displayads-formats.googleusercontent.com';
const allowedHosts = ['googlevideo.com', 'gstatic.com', 'googleusercontent.com', 'tpc.googlesyndication.com'];
const timeout = 12_000;

function scriptUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.origin !== origin || url.username || url.password || !url.pathname.endsWith('/content.js')) return null;
    const keys = ['htmlParentId', 'responseCallback'];
    const query = url.search.slice(1).split('&').filter(part =>
      part && !keys.some(key => new URLSearchParams(part).has(key)));
    url.search = '?' + [...query, 'htmlParentId=atc-preview', 'responseCallback=atcPreviewReady'].join('&');
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function previewDocument(url) {
  const src = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<base href="${origin}/">
<style>html,body{margin:0;overflow:hidden} #atc-preview{width:360px;height:300px;overflow:hidden}</style>
</head><body><div id="atc-preview"></div>
<script>
  window.atcPreviewReady = ({ previewMetadata } = {}) => {
    const { width, height } = previewMetadata?.[0] ?? {};
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) return;
    const target = document.getElementById('atc-preview');
    target.style.width = Math.max(1, Math.min(width, 400)) + 'px';
    target.style.height = Math.max(1, Math.min(height, 600)) + 'px';
    target.dataset.sized = 'true';
  };
</script><script async src="${src}"></script></body></html>`;
}

function previewReady(requireContent) {
  const text = document.body?.innerText?.trim() ?? '';
  if (/that[’']s an error|^(404|500)\./i.test(text)) return 'error';
  const target = document.getElementById('atc-preview');
  if (!target) return false;
  const content = target.innerText.trim() || target.querySelector(
    ':not(script, style, link, template):not([hidden])',
  );
  return Boolean(content || (!requireContent && target.dataset.sized));
}

function holdVideoStart() {
  for (const video of document.querySelectorAll('video')) {
    video.autoplay = false;
    video.pause();
    if (video.currentTime > 0) video.currentTime = 0;
  }
}

export async function createSnapshotter({ launch = options => chromium.launch(options) } = {}) {
  const browser = await launch({ channel: 'chrome', headless: true });
  let blocked = false;
  return {
    get blocked() { return blocked; },
    async snapshot(previewUrl) {
      const url = scriptUrl(previewUrl);
      if (!url || blocked) return null;
      const context = await browser.newContext({ viewport: { width: 400, height: 600 }, serviceWorkers: 'block' });
      try {
        await context.routeWebSocket('**/*', socket => socket.close());
        await context.route('**/*', async route => {
          const request = route.request();
          const { protocol, hostname, username, password, port } = new URL(request.url());
          if (blocked || protocol !== 'https:' || username || password || port ||
              !allowedHosts.some(host => hostname === host || hostname.endsWith('.' + host)) ||
              !['GET', 'HEAD'].includes(request.method())) return route.abort();
          try {
            // Kiểm tra từng yêu cầu, kể cả khi máy chủ trả về đích chuyển hướng.
            const response = await route.fetch({ maxRedirects: 0, timeout });
            try {
              const status = response.status();
              const headers = response.headers();
              const location = headers.location ? new URL(headers.location, request.url()).href : '';
              const html = /^text\/html\b/i.test(headers['content-type'] ?? '');
              if (isBlockedResponse({ status, url: location }) ||
                  (html && /unusual traffic from your computer network|id=["']captcha-form["']/i.test(await response.text()))) {
                blocked = true;
              }
              if (blocked || (status >= 300 && status < 400)) await route.abort();
              else await route.fulfill({ response });
            } finally {
              await response.dispose();
            }
          } catch {
            await route.abort().catch(() => {});
          }
        });
        const page = await context.newPage();
        await page.setContent(previewDocument(url), { waitUntil: 'domcontentloaded', timeout });
        const ready = await page.waitForFunction(previewReady, false, { timeout });
        if (await ready.jsonValue() === 'error' || blocked) return null;
        await Promise.all(page.frames().map(frame => frame.evaluate(holdVideoStart).catch(() => {})));
        await page.waitForTimeout(1500);
        if (blocked || await page.evaluate(previewReady, true) !== true) return null;
        const childResults = await Promise.all(page.frames().filter(frame => frame.parentFrame()).map(frame =>
          frame.evaluate(previewReady, true).catch(() => false)));
        if (childResults.includes('error')) return null;
        const png = await page.locator('#atc-preview').screenshot({ timeout, animations: 'disabled' });
        return blocked ? null : png;
      } catch {
        return null;
      } finally {
        await context.close();
      }
    },
    close: () => browser.close(),
  };
}

export function createSnapshotBackfill({ store, open = createSnapshotter, pause = sleep }) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const candidates = await store.creativesNeedingSnapshots(300);
      if (!candidates.length) return;
      const directory = store.imagesDir();
      const snapshotter = await open();
      try {
        let attempted = false;
        for (const { creativeId, previewUrl } of candidates) {
          if (!/^CR\d+$/.test(creativeId) || !await store.claimSnapshot(creativeId)) continue;
          if (attempted) await pause(300);
          attempted = true;
          const png = await snapshotter.snapshot(previewUrl);
          if (snapshotter.blocked) break;
          if (!png) continue;
          const filename = creativeId + '.png';
          const temporary = join(directory, filename + '.' + randomUUID() + '.tmp');
          try {
            await writeFile(temporary, png);
            await rename(temporary, join(directory, filename));
            await store.setCreativeImage(creativeId, 'images/' + filename);
          } finally {
            await rm(temporary, { force: true });
          }
        }
      } finally {
        await snapshotter.close();
      }
    } finally {
      running = false;
    }
  };
}
