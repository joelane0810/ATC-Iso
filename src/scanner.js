import { basename, join } from 'node:path';
import { BlockedError, buildSearchCreativesReq, parseCreatives } from './atc.js';

export async function runScan({ store, client, now = () => new Date(), log = console.log }) {
  const scannedAt = now();
  const result = { status: 'ok', watched: 0, newAds: 0 };

  try {
    for (const watch of await store.allWatches()) {
      const previous = await store.getAds(watch.id);
      const seen = new Set(Object.keys(previous?.ads ?? {}));
      const ads = new Map();
      const tokens = new Set();
      let pageToken = null;
      let pages = 0;

      do {
        const request = buildSearchCreativesReq({ watch, pageToken });
        const response = await client.rpc('SearchService/SearchCreatives', request);
        const { ads: pageAds, nextToken } = parseCreatives(response);
        pages++;
        let hasNewAds = false;
        for (const ad of pageAds) {
          ads.set(ad.creativeId, ad);
          if (!seen.has(ad.creativeId)) {
            seen.add(ad.creativeId);
            hasNewAds = true;
          }
        }

        if (previous ? !hasNewAds : pages >= 5) break;
        if (!nextToken || tokens.has(nextToken)) break;
        tokens.add(nextToken);
        pageToken = nextToken;
      } while (pageToken);

      // A blocked page must leave this watch's existing data intact.
      const { newIds } = await store.mergeAds(watch, [...ads.values()], scannedAt);
      result.watched++;
      result.newAds += newIds.length;

      for (const id of newIds) {
        if (basename(id) !== id || id === '..' || id === '.') continue;
        const image = await client.captureImage(ads.get(id), join(store.imagesDir(), id));
        if (image) await store.setAdImage(watch.id, id, `images/${basename(image)}`);
      }
    }
  } catch (error) {
    result.status = error instanceof BlockedError ? 'blocked' : 'error';
    result.error = error instanceof Error ? error.message : String(error);
    log(result.error);
  }

  await store.appendScanLog({ at: scannedAt.toISOString(), ...result });
  return result;
}
