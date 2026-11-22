import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { BlockedError, buildSearchCreativesReq, parseCreatives } from './atc.js';

const MAX_PAGES_FIRST = 5;
const MAX_PAGES_LATER = 10;
const RUNNING_WINDOW = 2 * 24 * 60 * 60 * 1000;

export async function runScan({
  store, client, now = () => new Date(), log = console.log,
  record = entry => store.appendScanLog(entry), waitForCapture = delay,
}) {
  const scannedAt = now();
  const result = { status: 'ok', watched: 0, newAds: 0 };
  const changes = [];
  const runningSince = scannedAt.getTime() - RUNNING_WINDOW;

  let retries = 0;
  let captures = 0;
  let nextCaptureAt = 0;
  try {
    for (const watch of await store.allWatches()) {
      const previous = await store.getAds(watch.id);
      const seen = new Set(Object.entries(previous?.ads ?? {})
        .filter(([, ad]) => ad.platform === 'search').map(([id]) => id));
      const previouslyRunning = [...seen].filter(
        id => Date.parse(previous.ads[id].lastShown) >= Date.parse(previous.lastScanAt) - RUNNING_WINDOW,
      );
      const ads = new Map();
      const tokens = new Set();
      let pageToken = null;
      let pages = 0;

      do {
        const request = buildSearchCreativesReq({ watch, pageToken });
        const response = await client.rpc('SearchService/SearchCreatives', request);
        const { ads: pageAds, nextToken } = parseCreatives(response);
        pages++;
        let hasUnconfirmedAds = false;
        for (const ad of pageAds) {
          ads.set(ad.creativeId, ad);
          if (!seen.has(ad.creativeId)) {
            seen.add(ad.creativeId);
            hasUnconfirmedAds = true;
          }
        }

        log(`Đang quét ${watch.label || watch.value}: trang ${pages}, ${ads.size} mẫu`);
        if (pages >= (previous ? MAX_PAGES_LATER : MAX_PAGES_FIRST)) break;
        if (previous && !hasUnconfirmedAds) break;
        if (!nextToken || tokens.has(nextToken)) break;
        tokens.add(nextToken);
        pageToken = nextToken;
      } while (pageToken);

      // A blocked page must leave this watch's existing data intact.
      // Retain the preview URL for retries outside the current page.
      const { file, newIds } = await store.mergeAds(watch, [...ads.values()].map(ad => ({
        ...ad,
        previewUrl: ad.previewUrl ?? ad.imageUrl ?? previous?.ads[ad.creativeId]?.previewUrl ?? null,
      })), scannedAt);
      result.watched++;
      result.newAds += newIds.length;

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

      const fresh = new Set(newIds);
      for (const id of [...newIds, ...Object.keys(file.ads).filter(id => !fresh.has(id))]) {
        if (captures >= 40) break;
        if (basename(id) !== id || id === '..' || id === '.') continue;
        const saved = file.ads[id];
        const ad = { ...saved };
        const previewUrl = ad.previewUrl ?? '';
        if (/^https:\/\/tpc\.googlesyndication\.com\/archive\/simgad\//i.test(previewUrl)
            || (ad.format === 'image' && previewUrl && !/\/content\.js(?:[?#]|$)/i.test(previewUrl))) {
          ad.imageUrl ??= previewUrl;
        }
        if (ad.image || !(ad.imageUrl || ad.previewUrl)) continue;
        if (!fresh.has(id)) {
          if (retries >= 20) continue;
          retries++;
        }
        const waitMs = Math.ceil(nextCaptureAt - performance.now());
        if (waitMs > 0) await waitForCapture(waitMs);
        captures++;
        const image = await client.captureImage(ad, join(store.imagesDir(), id));
        nextCaptureAt = performance.now() + 1500;
        if (image) await store.setAdImage(watch.id, id, `images/${basename(image)}`);
      }
    }
  } catch (error) {
    result.status = error instanceof BlockedError ? 'blocked' : 'error';
    result.error = error instanceof Error ? error.message : String(error);
    log(result.error);
  }

  await record({ at: scannedAt.toISOString(), ...result, changes });
  return result;
}
