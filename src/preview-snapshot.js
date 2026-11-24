import { chromium } from 'playwright-core';
import { isBlockedResponse } from './atc.js';
import { randomUUID } from 'node:crypto';
import { appendFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const origin = 'https://displayads-formats.googleusercontent.com';
const allowedHosts = ['googlevideo.com', 'gstatic.com', 'googleusercontent.com', 'googlesyndication.com', 'googleapis.com', 'ggpht.com', 'ytimg.com'];
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

export async function createSnapshotter({ launch = options => chromium.launch(options), note = () => {} } = {}) {
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
        // Bản xem trước cần tải thư viện từ nhiều máy chủ (Google, AMP…); chỉ chặn tuyệt đối trang ATC.
        await context.route('**/*', route => {
          const { protocol, hostname } = new URL(route.request().url());
          const forbidden = protocol !== 'https:' || hostname === 'adstransparency.google.com';
          return forbidden ? route.abort() : route.continue();
        });
        const page = await context.newPage();
        await page.setContent(previewDocument(url), { waitUntil: 'domcontentloaded', timeout });
        const ready = await page.waitForFunction(previewReady, false, { timeout });
        if (await ready.jsonValue() === 'error' || blocked) { note('google-error'); return null; }
        await Promise.all(page.frames().map(frame => frame.evaluate(holdVideoStart).catch(() => {})));
        await page.waitForTimeout(1500);
        if (blocked || await page.evaluate(previewReady, true) !== true) { note('empty'); return null; }
        const childResults = await Promise.all(page.frames().filter(frame => frame.parentFrame()).map(frame =>
          frame.evaluate(previewReady, true).catch(() => false)));
        if (childResults.includes('error')) { note('google-error'); return null; }
        const png = await page.locator('#atc-preview').screenshot({ timeout, animations: 'disabled' });
        return blocked ? null : png;
      } catch (error) {
        note('fail: ' + String(error?.message ?? error).split('\n')[0].slice(0, 160));
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
      const logFile = join(directory, '..', 'snapshot-log.txt');
      let current = '';
      const note = reason => appendFile(logFile, `${new Date().toISOString()} ${current} ${reason}\n`).catch(() => {});
      const snapshotter = await open({ note });
      try {
        let attempted = false;
        for (const { creativeId, previewUrl } of candidates) {
          if (!/^CR\d+$/.test(creativeId) || !await store.claimSnapshot(creativeId)) continue;
          if (attempted) await pause(300);
          attempted = true;
          current = creativeId;
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
