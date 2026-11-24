import { chromium } from 'playwright-core';
import { isBlockedResponse } from './atc.js';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const origin = 'https://displayads-formats.googleusercontent.com';
// Trang chứa bản xem trước được đặt CÙNG nguồn với khung adframe (như trang ATC thật), để quảng cáo vẽ được vào khung.
const hostPage = origin + '/atc-iso-preview.html';
// Ảnh PNG nhỏ hơn mức này gần như chắc chắn là ảnh trắng.
const MIN_PNG_BYTES = 2500;
// Giống trang /adframe của ATC: nhận nội dung quảng cáo từ trang cha qua postMessage rồi vẽ ra.
export const ADFRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><script>
window.addEventListener('message', function (e) {
  if (e.source !== window.parent || !e.data || !e.data.html) return;
  document.open('text/html', 'replace');
  document.write(e.data.html);
  document.close();
});
</script></body></html>`;
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

export async function createSnapshotter({ launch = options => chromium.launch(options), note = () => {}, debugDir = null } = {}) {
  let debugCount = 0;
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
          const { protocol, hostname, pathname } = new URL(route.request().url());
          // Khung "adframe" vốn do trang ATC cung cấp (trang trống để quảng cáo vẽ vào) — tự trả trang trống.
          if (route.request().url() === hostPage) {
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: previewDocument(url) });
          }
          if (pathname === '/adframe') {
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
              body: ADFRAME_HTML });
          }
          const forbidden = protocol !== 'https:' || hostname === 'adstransparency.google.com';
          return forbidden ? route.abort() : route.continue();
        });
        const page = await context.newPage();
        await page.goto(hostPage, { waitUntil: 'domcontentloaded', timeout });
        const ready = await page.waitForFunction(previewReady, false, { timeout });
        if (await ready.jsonValue() === 'error' || blocked) {
          note('google-error');
          if (debugDir && debugCount++ < 3) {
            await page.screenshot({ path: join(debugDir, `loi-${debugCount}.png`) }).catch(() => {});
            await writeFile(join(debugDir, `loi-${debugCount}.txt`), await page.evaluate(() => document.body.innerText.slice(0, 2000)
              + '\n---\n' + document.documentElement.outerHTML.slice(0, 4000))).catch(() => {});
          }
          return null;
        }
        await Promise.all(page.frames().map(frame => frame.evaluate(holdVideoStart).catch(() => {})));
        await page.waitForTimeout(1500);
        if (blocked || await page.evaluate(previewReady, true) !== true) { note('empty'); return null; }
        // Chỉ coi là mẫu hỏng khi KHUNG LỚN đang hiện trang lỗi của Google; khung đo lường ẩn/nhỏ bỏ qua.
        let visibleError = false;
        for (const frame of page.frames().filter(item => item.parentFrame())) {
          if (await frame.evaluate(previewReady, true).catch(() => false) !== 'error') continue;
          const box = await (await frame.frameElement().catch(() => null))?.boundingBox().catch(() => null);
          if (box && box.width >= 150 && box.height >= 80) visibleError = true;
        }
        if (visibleError) {
          note('google-error-frame');
          if (debugDir && debugCount++ < 3) {
            await page.screenshot({ path: join(debugDir, `khung-${debugCount}.png`) }).catch(() => {});
            const frames = await Promise.all(page.frames().map(async frame => frame.url() + ' :: '
              + (await frame.evaluate(() => document.body?.innerText?.slice(0, 300)).catch(() => '?'))));
            await writeFile(join(debugDir, `khung-${debugCount}.txt`), frames.join('\n\n')).catch(() => {});
          }
          return null;
        }
        const png = await page.locator('#atc-preview').screenshot({ timeout, animations: 'disabled' });
        if (png.length < MIN_PNG_BYTES) {
          note('blank');
          if (debugDir && debugCount++ < 3) {
            await page.screenshot({ path: join(debugDir, `trang-${debugCount}.png`), fullPage: true }).catch(() => {});
            const frames = await Promise.all(page.frames().map(async frame => frame.url() + ' :: '
              + (await frame.evaluate(() => (document.body?.innerText ?? '').slice(0, 200) + ' || '
                + document.documentElement.outerHTML.length + ' || ' + document.documentElement.outerHTML.slice(0, 1500)).catch(e => '?' + e.message))));
            const box = await page.locator('#atc-preview').boundingBox().catch(() => null);
            await writeFile(join(debugDir, `trang-${debugCount}.txt`), JSON.stringify(box) + '\n' + frames.join('\n\n')).catch(() => {});
          }
          return null;
        }
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
      await store.resetSnapshotAttemptsBefore?.('2026-11-24T06:10:00.000Z');
      // Gỡ các ảnh trắng đã lỡ lưu ở bản trước.
      for (const { creativeId, image } of (await store.snapshotImages?.()) ?? []) {
        const path = join(store.imagesDir(), image.replace(/^images\//, ''));
        const size = await stat(path).then(info => info.size).catch(() => 0);
        if (size < MIN_PNG_BYTES) {
          await rm(path, { force: true });
          await store.clearCreativeImage?.(creativeId);
        }
      }
      const candidates = await store.creativesNeedingSnapshots(300);
      if (!candidates.length) return;
      const directory = store.imagesDir();
      const logFile = join(directory, '..', 'snapshot-log.txt');
      let current = '';
      const note = reason => appendFile(logFile, `${new Date().toISOString()} ${current} ${reason}\n`).catch(() => {});
      const debugDir = join(directory, '..', 'snapshot-debug');
      await mkdir(debugDir, { recursive: true }).catch(() => {});
      const snapshotter = await open({ note, debugDir });
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
