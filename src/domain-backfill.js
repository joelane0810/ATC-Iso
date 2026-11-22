import { setTimeout as delay } from 'node:timers/promises';
import { BlockedError, isBlockedResponse } from './atc.js';
import { createDomainReader } from './domain-ocr.js';

let running = false;

async function fetchImage(url, fetchImageResponse) {
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 10; redirects++) {
    if (isBlockedResponse({ url })) throw new BlockedError('Google đã chặn tải ảnh.');
    const response = await fetchImageResponse(url, { signal, redirect: 'manual' });
    const contentType = response.headers?.get('content-type') ?? '';
    if (isBlockedResponse({ url: response.url, status: response.status, contentType })
      || response.status === 403) {
      await response.body?.cancel();
      throw new BlockedError('Google đã chặn tải ảnh.');
    }
    if (response.ok) {
      const image = Buffer.from(await response.arrayBuffer());
      if (isBlockedResponse({ text: image.subarray(0, 1024).toString() })) {
        throw new BlockedError('Google đã chặn tải ảnh.');
      }
      return image;
    }
    const location = response.headers?.get('location');
    await response.body?.cancel();
    if (response.status < 300 || response.status >= 400 || !location) return null;
    url = new URL(location, url).href;
  }
  return null;
}

export async function backfillDomains({
  store, fetchImageResponse = globalThis.fetch, createReader = createDomainReader,
  wait = delay, log = console.log, now = () => new Date(),
}) {
  if (running) return;
  running = true;
  let reader;
  let attempted = 0;
  let found = 0;
  try {
    const candidates = await store.creativesNeedingDomains(500, { remoteOnly: true, now: now() });
    for (const { creativeId, imageUrl } of candidates) {
      if (!await store.claimDomainOcr(creativeId, now())) continue;
      if (attempted) await wait(300);
      attempted++;
      let image;
      try {
        image = await fetchImage(imageUrl, fetchImageResponse);
      } catch (error) {
        if (error instanceof BlockedError) throw error;
        continue;
      }
      if (!image) continue;
      reader ??= await createReader();
      const domain = await reader.read(image).catch(() => null);
      if (domain && await store.setCreativeDomain(creativeId, domain)) found++;
    }
  } catch (error) {
    log(`Đọc bù tên miền dừng: ${error.message}`);
  } finally {
    try {
      await reader?.close();
    } finally {
      running = false;
      log(`Đọc bù tên miền: tìm được ${found}/${attempted} mẫu.`);
    }
  }
  return { attempted, found };
}
