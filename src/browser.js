import { mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, errors } from 'playwright-core';
import { isAtcUrl } from './tab-guard.js';
import { BlockedError, isBlockedResponse, parseCreativeRegions, RPC_BASE } from './atc.js';

const landingUrl = 'https://adstransparency.google.com/?region=anywhere';
const blockedMessage = 'Google đã chặn lượt quét';
const imageTimeout = 8_000;
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
const detailTimeout = 15_000;

function parseJson(text) {
  return JSON.parse(text.replace(/^\)\]\}'[^\S\n]*\r?\n/, ''));
}

function hasCaptcha() {
  return Boolean(document.querySelector(
    '#captcha-form, #recaptcha, .g-recaptcha, form[action*="/sorry/"], iframe[src*="/recaptcha/"]',
  )) || /unusual traffic from your computer network/i.test(document.body?.innerText ?? '');
}

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

async function captureDirectImage(context, imageUrl, destNoExt) {
  const deadline = performance.now() + imageTimeout;
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
  profileDir, minDelayMs = 8000, jitterMs = 4000, headless = false, debugDir = null, maxTabs = 2,
  launch = (dir, options) => chromium.launchPersistentContext(dir, options), log = console.error,
}) {
  const context = await launch(profileDir, { channel: 'chrome', headless });
  let page;
  let detailPage;
  let openingTab = true;
  let blocked = false;
  let nextAt = 0;
  const markRequest = () => { nextAt = performance.now() + minDelayMs + Math.random() * jitterMs; };
  const isSorry = () => isBlockedResponse({ url: page.url() })
    || isBlockedResponse({ url: detailPage?.url() });

  try {
    // Hồ sơ trình duyệt có thể tự mở lại tab cũ: chỉ giữ một tab, đóng hết phần còn lại.
    const existing = context.pages?.() ?? [];
    page = existing[0] ?? await context.newPage();
    for (const extra of existing.slice(1)) await extra.close().catch(() => {});
    openingTab = false;
    // Tab bật ra ngoài ý muốn (cửa sổ mới) cũng đóng ngay để không vượt số tab ATC cho phép.
    context.on?.('page', opened => {
      if (!openingTab && opened !== page && opened !== detailPage) opened.close().catch(() => {});
    });
    page.on('response', response => {
      const request = response.request();
      if (!request.isNavigationRequest() || request.resourceType() !== 'document') return;
      const { status, url, redirectedTo } = responseMetadata(response);
      blocked ||= isBlockedResponse({ status, url }) || isBlockedResponse({ url: redirectedTo });
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && isBlockedResponse({ url: frame.url() })) blocked = true;
    });
    markRequest();
    const response = await page.goto(landingUrl, { waitUntil: 'domcontentloaded', timeout: rpcTimeout });
    blocked ||= isSorry() || response?.status() === 429;
    if (!blocked) {
      blocked = await page.evaluate(hasCaptcha);
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

  let queue = Promise.resolve();

  async function paced(operation) {
    if (blocked || isSorry()) throw new BlockedError(blockedMessage);
    const waitMs = Math.ceil(nextAt - performance.now());
    if (waitMs > 0) await delay(waitMs);
    if (blocked || isSorry()) throw new BlockedError(blockedMessage);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BlockedError || blocked || isSorry()) {
        blocked = true;
        throw new BlockedError(blockedMessage);
      }
      throw error;
    }
  }

  function enqueue(operation) {
    const pending = queue.then(() => paced(operation));
    queue = pending.catch(() => {});
    return pending;
  }

  async function request(method, req) {
    try {
      return await requestOnce(method, req);
    } catch (error) {
      // Trang ATC tự tải lại/chuyển trang giữa chừng: chờ trang ổn định rồi thử lại đúng một lần.
      if (!/Execution context was destroyed|Target page, context or browser has been closed|frame was detached/i.test(String(error?.message))) throw error;
      await page.waitForLoadState?.('domcontentloaded', { timeout: rpcTimeout }).catch(() => {});
      if (!String(page.url?.() ?? '').startsWith('https://adstransparency.google.com/')) {
        await page.goto(landingUrl, { waitUntil: 'domcontentloaded', timeout: rpcTimeout });
      }
      return requestOnce(method, req);
    }
  }

  async function requestOnce(method, req) {
    markRequest();
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
    return parseJson(response.text);
  }

  let debugSaved = false;
  const seenUrls = [];
  async function lookupRegions({ advertiserId, creativeId }) {
    if (!detailPage && maxTabs < 2) detailPage = page;
    if (!detailPage) {
      openingTab = true;
      try { detailPage = await context.newPage(); } finally { openingTab = false; }
      detailPage.on?.('response', r => { try { seenUrls.push(r.status() + ' ' + r.url().slice(0, 160)); } catch {} });
    }
    const url = new URL(
      `/advertiser/${encodeURIComponent(advertiserId)}/creative/${encodeURIComponent(creativeId)}?region=anywhere&platform=SEARCH`,
      landingUrl,
    );
    // Tín hiệu chặn chỉ tính từ chính ATC hoặc chuyển hướng tới trang captcha.
    // Tệp phụ của máy chủ khác (vd. máy ghi nhật ký trả 429) không phải tín hiệu chặn.
    const detail = detailPage.waitForResponse(response => {
      const { status, url, redirectedTo, contentType } = responseMetadata(response);
      const matches = url.includes('LookupService/GetCreativeById');
      let host = '';
      try { host = new URL(url).hostname; } catch {}
      if (matches || host === 'adstransparency.google.com') {
        assertUnblocked({ status, url, redirectedTo, contentType: matches ? contentType : '' });
      } else if (isBlockedResponse({ url: redirectedTo })) {
        throw new BlockedError(blockedMessage);
      }
      return matches;
    }, { timeout: detailTimeout });
    markRequest();
    const navigation = detailPage.goto(url.href, { waitUntil: 'domcontentloaded', timeout: detailTimeout })
      .then(async response => {
        if (isSorry() || response?.status() === 429 || await detailPage.evaluate(hasCaptcha)) {
          throw new BlockedError(blockedMessage);
        }
      });
    try {
      const [response] = await Promise.all([detail, navigation]);
      if (blocked || isSorry()) throw new BlockedError(blockedMessage);
      if (!response.ok()) {
        if (debugDir && !debugSaved) {
          debugSaved = true;
          try {
            mkdirSync(debugDir, { recursive: true });
            const body = await response.text().catch(() => '');
            writeFileSync(joinPath(debugDir, 'quoc-gia-loi.txt'), [`status ${response.status()}`, body.slice(0, 500), detailPage.url(), ...seenUrls.slice(-60)].join('\n'));
            await detailPage.screenshot({ path: joinPath(debugDir, 'quoc-gia-loi.png'), fullPage: true });
          } catch {}
        }
        return null;
      }
      const text = await response.text();
      assertUnblocked({ text });
      const regions = parseCreativeRegions(parseJson(text));
      if (regions === null && debugDir && !debugSaved) {
        debugSaved = true;
        try {
          mkdirSync(debugDir, { recursive: true });
          const request = response.request();
          writeFileSync(joinPath(debugDir, 'quoc-gia-loi.txt'), ['thiếu 17', 'req: ' + String(request.postData() || '').slice(0, 400), 'res: ' + text.replace(/https?:[^"]+/g, 'URL').slice(0, 1500), detailPage.url()].join('\n'));
          await detailPage.screenshot({ path: joinPath(debugDir, 'quoc-gia-loi.png'), fullPage: true });
        } catch {}
      }
      return regions;
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      log(`Trang chi tiết ${creativeId}: hết thời gian chờ (${detailPage.url()})`);
      if (isSorry() || await detailPage.evaluate(hasCaptcha)) throw new BlockedError(blockedMessage);
      if (debugDir && !debugSaved) {
        debugSaved = true;
        try {
          mkdirSync(debugDir, { recursive: true });
          writeFileSync(joinPath(debugDir, 'quoc-gia-loi.txt'), ['timeout', detailPage.url(), ...seenUrls.slice(-60)].join('\n'));
          await detailPage.screenshot({ path: joinPath(debugDir, 'quoc-gia-loi.png'), fullPage: true });
        } catch (error) {
          try { writeFileSync(joinPath(debugDir, 'quoc-gia-loi-ghi.txt'), String(error?.stack || error)); } catch {}
        }
      }
      return null;
    }
  }

  return {
    rpc(method, req) {
      return enqueue(() => request(method, req));
    },

    lookupRegions(ids) {
      return enqueue(() => lookupRegions(ids));
    },

    async captureImage(ad, destNoExt) {
      if (blocked || isSorry()) throw new BlockedError(blockedMessage);
      if (!ad.imageUrl) return null;
      try {
        await mkdir(dirname(destNoExt), { recursive: true });
        return await captureDirectImage(context, ad.imageUrl, destNoExt);
      } catch (error) {
        if (error instanceof BlockedError || blocked || isSorry()) {
          blocked = true;
          throw new BlockedError(blockedMessage);
        }
        log(`Không tải được ảnh xem trước ${ad.creativeId ?? ''}: ${error.message}`);
        return null;
      }
    },

    atcTabCount() {
      return (context.pages?.() ?? []).filter(open => isAtcUrl(open.url())).length;
    },

    close: () => context.close(),
  };
}
