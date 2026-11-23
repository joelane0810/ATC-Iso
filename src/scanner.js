import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { BlockedError, buildSearchCreativesReq, parseCreatives } from './atc.js';
import { createDomainReader } from './domain-ocr.js';

const MAX_DOMAIN_ATTEMPTS = 200;
const MAX_PAGES_FIRST = 5;
const MAX_PAGES_LATER = 10;
const DEFAULT_MAX_DETAILS = 20;
const RUNNING_WINDOW = 2 * 24 * 60 * 60 * 1000;

export async function runScan({
  store, client, now = () => new Date(), log = console.log,
  maxDetails = typeof client.lookupRegions === 'function' ? DEFAULT_MAX_DETAILS : 0,
  onlyWatchIds = null, maxPages = null, skipCaptures = false, scanId,
  createReader = createDomainReader,
  record = entry => store.appendScanLog(entry), waitForCapture = delay,
  progress = () => {},
}) {
  const scannedAt = now();
  const result = { status: 'ok', watched: 0, newAds: 0 };
  const changes = [];
  const runningSince = scannedAt.getTime() - RUNNING_WINDOW;

  const attemptedDetails = new Set();
  scanId ??= await store.beginScan?.(scannedAt.toISOString());
  let retries = 0;
  let captures = 0;
  let nextCaptureAt = 0;
  let reader;
  let ocrAttempts = 0;
  let ocrUnavailable = false;
  async function capture(ad, id, watchId) {
    const waitMs = Math.ceil(nextCaptureAt - performance.now());
    if (waitMs > 0) await waitForCapture(waitMs);
    if (store.isWatchActive && !store.isWatchActive(watchId)) return null;
    const image = await client.captureImage(ad, join(store.imagesDir(), id));
    nextCaptureAt = performance.now() + 1500;
    return image;
  }
  // Báo tiến độ từng mục cho giao diện: chờ → đang quét (trang x/y) → quốc gia → xong.
  const report = event => { try { progress(event); } catch {} };
  let currentWatchId = null;
  const finishWatch = () => {
    if (currentWatchId) report({ type: 'done', watchId: currentWatchId });
    currentWatchId = null;
  };
  try {
    await store.purgeExpiredTrash?.(scannedAt);
    const watches = (await store.allWatches()).filter(w => !onlyWatchIds || onlyWatchIds.includes(w.id));
    report({ type: 'start', watchIds: watches.map(w => w.id) });
    let regionFailures = 0;
    const watchCount = watches.length || 1;
    const baseQuota = Math.floor(maxDetails / watchCount);
    const extra = maxDetails % watchCount;
    const offset = Math.floor(scannedAt.getTime() / 86_400_000) % watchCount;
    watchesLoop: for (const [index, watch] of watches.entries()) {
      const quota = baseQuota + Number((index - offset + watches.length) % watches.length < extra);
      finishWatch();
      const previous = await store.getAds(watch.id);
      const pageLimit = maxPages ?? (previous ? MAX_PAGES_LATER : MAX_PAGES_FIRST);
      currentWatchId = watch.id;
      report({ type: 'page', watchId: watch.id, page: 0, maxPages: pageLimit, ads: 0 });
      const seen = new Set(Object.entries(previous?.ads ?? {})
        .filter(([, ad]) => ad.platform === 'search').map(([id]) => id));
      const previouslyRunning = [...seen].filter(
        id => Date.parse(previous.ads[id].lastShown) >= Date.parse(previous.lastScanAt) - RUNNING_WINDOW,
      );
      const ads = new Map();
      const tokens = new Set();
      let pageToken = null;
      let pages = 0;
      let refreshThrough = null;

      do {
        if (store.isWatchActive && !store.isWatchActive(watch.id)) continue watchesLoop;
        const request = buildSearchCreativesReq({ watch, pageToken });
        const response = await client.rpc('SearchService/SearchCreatives', request);
        const { ads: pageAds, nextToken } = parseCreatives(response);
        pages++;
        let hasUnconfirmedAds = false;
        for (const ad of pageAds) {
          const lastShown = ads.get(ad.creativeId)?.lastShown;
          ads.set(ad.creativeId, { ...ad,
            lastShown: !ad.lastShown || Date.parse(lastShown) > Date.parse(ad.lastShown) ? lastShown ?? ad.lastShown : ad.lastShown,
          });
          if (!seen.has(ad.creativeId)) {
            seen.add(ad.creativeId);
            hasUnconfirmedAds = true;
          }
        }

        log(`Đang quét ${watch.label || watch.value}: trang ${pages}, ${ads.size} mẫu`);
        report({ type: 'page', watchId: watch.id, page: pages, maxPages: pageLimit, ads: ads.size });
        if (pages >= pageLimit) break;
        if (previous && !hasUnconfirmedAds && refreshThrough == null) refreshThrough = pages + 3;
        if (pages === refreshThrough) break;
        if (!nextToken || tokens.has(nextToken)) break;
        tokens.add(nextToken);
        pageToken = nextToken;
      } while (pageToken);

      if (store.isWatchActive && !store.isWatchActive(watch.id)) continue;

      // A blocked page must leave this watch's existing data intact.
      // Keep the preview URL for the web interface and older image records.
      const { file, newIds } = await store.mergeAds(watch, [...ads.values()].map(ad => ({
        ...ad,
        domain: ad.domain?.trim() ? ad.domain : watch.type === 'domain' ? watch.value : null,
        previewUrl: ad.previewUrl ?? ad.imageUrl ?? previous?.ads[ad.creativeId]?.previewUrl ?? null,
      })), scannedAt, scanId);
      result.watched++;
      result.newAds += newIds.length;
      report({ type: 'saved', watchId: watch.id, ads: ads.size, newAds: newIds.length });

      const searchAds = Object.values(file.ads).filter(ad => ad.platform === 'search');
      changes.push({
        watchId: watch.id,
        label: file.watch?.label ?? watch.label,
        kind: watch.kind ?? 'competitor',
        newIds,
        stoppedIds: previouslyRunning.filter(id => Date.parse(file.ads[id].lastShown) < runningSince),
        running: searchAds.filter(ad => Date.parse(ad.lastShown) >= runningSince).length,
        total: searchAds.length,
      });

      if (quota > 0 && typeof client.lookupRegions === 'function' && store.creativesNeedingRegions) {
        const pending = await store.creativesNeedingRegions(quota + attemptedDetails.size, {
          watchId: watch.id, now: scannedAt,
        });
        const regionList = pending.filter(ad => !attemptedDetails.has(ad.creativeId)).slice(0, quota);
        let regionDone = 0;
        if (regionList.length) report({ type: 'regions', watchId: watch.id, done: 0, total: regionList.length });
        for (const creative of regionList) {
          attemptedDetails.add(creative.creativeId);
          const { advertiserId, creativeId } = creative;
          if (regionFailures >= 3) break;
          if (store.isWatchActive && !store.isWatchActive(watch.id)) continue watchesLoop;
          const regions = await client.lookupRegions({ advertiserId, creativeId });
          regionFailures = regions === null ? regionFailures + 1 : 0;
          log(`Quốc gia ${creativeId}: ${regions === null ? 'chưa lấy được' : regions.length + ' nước'}`);
          await store.setCreativeRegions(creative.creativeId, regions, scannedAt);
          report({ type: 'regions', watchId: watch.id, done: ++regionDone, total: regionList.length });
        }
      }

      const fresh = new Set(newIds);
      const captureIds = skipCaptures ? [] : [...newIds, ...Object.keys(file.ads).filter(id => !fresh.has(id))];
      const attemptedImages = new Set();
      for (const id of captureIds) {
        if (captures >= 40) break;
        if (basename(id) !== id || id === '..' || id === '.') continue;
        const saved = file.ads[id];
        const ad = { ...saved };
        const previewUrl = ad.previewUrl ?? '';
        if (/^https:\/\/tpc\.googlesyndication\.com\/archive\/simgad\//i.test(previewUrl)) {
          ad.imageUrl ??= previewUrl;
        }
        if (ad.image || !ad.imageUrl) continue;
        if (!fresh.has(id)) {
          if (retries >= 20) continue;
          retries++;
        }
        if (store.isWatchActive && !store.isWatchActive(watch.id)) continue watchesLoop;
        captures++;
        attemptedImages.add(id);
        const image = await capture(ad, id, watch.id);
        if (image) await store.setAdImage(watch.id, id, `images/${basename(image)}`);
      }

      if (ocrUnavailable || ocrAttempts >= MAX_DOMAIN_ATTEMPTS || !store.creativesNeedingDomains) continue;
      const pending = await store.creativesNeedingDomains(MAX_DOMAIN_ATTEMPTS - ocrAttempts, {
        watchId: watch.id, now: now(), localOnly: skipCaptures,
      });
      for (const ad of pending) {
        const { creativeId: id, image, imageUrl } = ad;
        if (store.isWatchActive && !store.isWatchActive(watch.id)) continue watchesLoop;
        if (!await store.claimDomainOcr(id, now())) continue;
        ocrAttempts++;
        let input = image && await readFile(join(store.imagesDir(), basename(image))).catch(() => null);
        if (!input && imageUrl && !skipCaptures && !attemptedImages.has(id)
          && basename(id) === id && id !== '.' && id !== '..') {
          input = await capture(ad, id, watch.id);
          if (input) await store.setAdImage(watch.id, id, `images/${basename(input)}`);
        }
        if (!input) continue;
        try {
          reader ??= await createReader();
        } catch (error) {
          log(`Không mở được bộ đọc tên miền: ${error.message}`);
          ocrUnavailable = true;
          break;
        }
        const domain = await reader.read(input).catch(() => null);
        if (domain) await store.setCreativeDomain(id, domain);
      }
    }
    finishWatch();
  } catch (error) {
    if (currentWatchId) report({ type: 'error', watchId: currentWatchId, blocked: error instanceof BlockedError });
    currentWatchId = null;
    result.status = error instanceof BlockedError ? 'blocked' : 'error';
    result.error = error instanceof Error ? error.message : String(error);
    log(result.error);
  } finally {
    try {
      await reader?.close();
    } catch (error) {
      log(`Không đóng được bộ đọc tên miền: ${error.message}`);
    }
  }

  // The logging callback finalizes the same scan row that owns the watch snapshots.
  await record({ at: scannedAt.toISOString(), ...result, changes, ...(scanId == null ? {} : { scanId }) });
  return result;
}
