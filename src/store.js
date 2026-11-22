import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWatchInput, regionIdToIso, slugify } from './atc.js';
import { openDb } from './db.js';
import { groupIdentity, runningAt } from './groups.js';
import { adsDateRange, createTimeReport, vietnamDate } from './time-report.js';
import { scanResumeAt } from './scan-rest.js';
import { createWebStore } from './web-store.js';

const DAY = 24 * 60 * 60 * 1000;
const watchFields = 'w.id, w.type, w.value, w.region, p.label, p.kind, p.added_at AS addedAt';
const groupTypeFor = (kind) => kind === 'project' ? 'advertiser' : 'domain';

function pathId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/i.test(id)) throw new Error('Mã không hợp lệ');
  return id;
}

export function createStore(root, options) {
  const data = resolve(root, 'data');
  const { run, get, all, transaction, ensureWatch, linkWatch, saveAd, saveScan, saveSnapshot, close } =
    openDb(data, options);
  const listProfiles = () => all('SELECT id, name, created_at AS createdAt FROM profiles ORDER BY rowid')
    .map(row => ({ ...row }));
  const getWatchlist = (pid) => all(`SELECT ${watchFields} FROM profile_watches p
    JOIN watches w ON w.id = p.watch_id WHERE p.profile_id = ? ORDER BY p.rowid`, pathId(pid))
    .map(row => ({ ...row }));
  const getAds = (wid) => {
    const row = get(`SELECT id, type, value, region, label, kind, added_at AS addedAt, last_scan_at AS lastScanAt
      FROM watches WHERE id = ?`, pathId(wid));
    if (!row?.lastScanAt) return null;
    const { lastScanAt, ...watch } = row;
    const ads = Object.fromEntries(all(`SELECT wc.creative_id, wc.observation, c.image FROM watch_creatives wc
      JOIN creatives c ON c.id = wc.creative_id WHERE wc.watch_id = ? ORDER BY wc.rowid`, wid)
      .map(({ creative_id, observation, image }) => {
        const ad = JSON.parse(observation);
        return [creative_id, { ...ad, image: image ?? ad.image ?? null }];
      }));
    return { watch, lastScanAt, ads };
  };

  const scanHistory = (at) => all(`SELECT entry FROM scans WHERE status IS NOT NULL AND status != 'running'
    AND (? IS NULL OR julianday(at) <= julianday(?)) ORDER BY id DESC LIMIT 30`, at, at)
    .reverse().map(({ entry }) => JSON.parse(entry));
  const getScanLog = () => scanHistory(null);
  function regionsByCreative(rows) {
    const result = new Map();
    for (const { creativeId, regionId, lastShown } of rows) {
      if (!result.has(creativeId)) result.set(creativeId, []);
      result.get(creativeId).push({ regionId, iso: regionIdToIso(regionId), lastShown });
    }
    return result;
  }

  return {
    close,
    read: work => transaction(work, 'DEFERRED'),
    forWeb: () => createWebStore(root),
    listProfiles,
    addProfile(name) {
      name = name.trim();
      if (!name) throw new Error('Vui lòng nhập tên hồ sơ');
      return transaction(() => {
        const base = slugify(name) || 'ho-so';
        let id = base;
        for (let suffix = 2; get('SELECT 1 FROM profiles WHERE id = ?', id); suffix++) id = `${base}-${suffix}`;
        const profile = { id, name, createdAt: new Date().toISOString() };
        run('INSERT INTO profiles VALUES (?, ?, ?)', id, name, profile.createdAt);
        return profile;
      });
    },
    getWatchlist,
    addWatch(pid, input, region = null, kind = 'competitor') {
      if (kind !== 'competitor' && kind !== 'project') throw new Error('Loại theo dõi không hợp lệ.');
      return transaction(() => {
        const named = get(`SELECT a.id, a.name FROM advertisers a JOIN creatives c ON c.advertiser_id = a.id
          WHERE fold_name(a.name) = fold_name(?) AND fold_name(a.name) != ''
          GROUP BY a.id ORDER BY count(*) DESC, a.id LIMIT 1`, input);
        let parsed;
        try {
          parsed = parseWatchInput(input);
        } catch (error) {
          if (!named) throw error;
        }
        const { type, value } = named && parsed?.type !== 'advertiser'
          ? { type: 'advertiser', value: named.id } : parsed;
        const label = type === 'advertiser'
          ? get('SELECT name FROM advertisers WHERE id = ?', value)?.name || value : value;
        const watches = getWatchlist(pid);
        if (!get('SELECT 1 FROM profiles WHERE id = ?', pid)) throw new Error('Không tìm thấy hồ sơ.');
        const existing = watches.find(watch => watch.type === type && watch.value === value && watch.region === region);
        if (existing) {
          run('UPDATE profile_watches SET kind = ? WHERE profile_id = ? AND watch_id = ?', kind, pid, existing.id);
          return { ...existing, kind };
        }

        const base = pathId(region == null ? slugify(value) : `${slugify(value)}-r${region}`);
        const shared = get('SELECT id FROM watches WHERE type = ? AND value = ? AND region IS ? LIMIT 1',
          type, value, region);
        let id = shared?.id ?? base;
        if (!shared) {
          for (let suffix = 2; get('SELECT 1 FROM watches WHERE id = ?', id); suffix++) id = `${base}-${suffix}`;
        }
        const watch = { id, type, value, label, region, kind, addedAt: new Date().toISOString() };
        linkWatch(pid, watch);
        return watch;
      });
    },
    removeWatch(pid, wid) {
      transaction(() => run('DELETE FROM profile_watches WHERE profile_id = ? AND watch_id = ?', pathId(pid), wid));
    },
    allWatches() {
      const watches = new Map();
      for (const { id } of listProfiles()) {
        for (const watch of getWatchlist(id)) {
          const key = JSON.stringify([watch.type, watch.value, watch.region]);
          if (!watches.has(key)) watches.set(key, watch);
        }
      }
      return [...watches.values()];
    },
    getAds,
    mergeAds(watch, rawAds, now, scanId) {
      const lastScanAt = new Date(now).toISOString();
      return transaction(() => {
        ensureWatch(watch);
        const previousFile = getAds(watch.id);
        const ads = Object.assign(Object.create(null), previousFile?.ads);
        const newIds = [];
        for (const raw of rawAds) {
          const previous = ads[raw.creativeId];
          if (!previous) newIds.push(raw.creativeId);
          const ad = {
            ...raw,
            platform: 'search',
            firstShown: raw.firstShown ?? previous?.firstShown ?? null,
            lastShown: Date.parse(previous?.lastShown) > Date.parse(raw.lastShown)
              ? previous.lastShown : raw.lastShown ?? previous?.lastShown ?? null,
            imageUrl: raw.imageUrl ?? previous?.imageUrl ?? null,
            image: previous?.image ?? null,
            firstSeenByUs: previous?.firstSeenByUs ?? lastScanAt,
          };
          saveAd(watch.id, ad);
          ads[raw.creativeId] = ad;
        }
        const savedLabel = previousFile?.watch.label;
        const advertiserName = savedLabel && savedLabel !== watch.value
          ? savedLabel : rawAds[0]?.advertiserName?.trim();
        const label = watch.type === 'advertiser' && watch.label === watch.value && advertiserName
          ? advertiserName : watch.label;
        run('UPDATE watches SET last_scan_at = ?, label = ?, kind = ? WHERE id = ?',
          lastScanAt, label, watch.kind ?? 'competitor', watch.id);
        if (watch.type === 'advertiser' && label !== watch.value) {
          run('UPDATE profile_watches SET label = ? WHERE watch_id = ? AND label = ?', label, watch.id, watch.value);
        }
        if (scanId != null) saveSnapshot(scanId, watch.id, lastScanAt, Object.values(ads));
        return { file: { watch: { ...watch, label }, lastScanAt, ads: { ...ads } }, newIds };
      });
    },
    setAdImage(wid, cr, relPath) {
      transaction(() => run(`UPDATE creatives SET image = ? WHERE id = ? AND EXISTS (
        SELECT 1 FROM watch_creatives WHERE watch_id = ? AND creative_id = ?)`, relPath, cr, pathId(wid), cr));
    },
    beginScan(at, watchId = null) {
      return transaction(() => saveScan({ at, status: 'running', watchId }));
    },
    appendScanLog(entry) {
      return transaction(() => {
        const { scanId, ...logEntry } = entry;
        if (scanId == null) return saveScan(logEntry);
        run('UPDATE scans SET status = ?, error = ?, entry = ? WHERE id = ?',
          entry.status, entry.error ?? null, JSON.stringify(logEntry), scanId);
        return scanId;
      });
    },
    setScanSync(scanId, sync) {
      transaction(() => {
        const { entry } = get('SELECT entry FROM scans WHERE id = ?', scanId);
        run('UPDATE scans SET sync = ?, entry = ? WHERE id = ?',
          JSON.stringify(sync), JSON.stringify({ ...JSON.parse(entry), sync }), scanId);
      });
    },
    checkpoint() {
      return get('PRAGMA wal_checkpoint(TRUNCATE)').busy === 0;
    },
    getScanLog,
    setCreativeRegions(cr, regions, now = new Date()) {
      transaction(() => {
        if (regions == null) {
          run('UPDATE creatives SET regions_retry = 1 WHERE id = ?', cr);
          return;
        }
        run('DELETE FROM creative_regions WHERE creative_id = ?', cr);
        for (const { regionId, firstShown, lastShown } of regions) {
          run(`INSERT INTO creative_regions (creative_id, region_id, first_shown, last_shown)
            VALUES (?, ?, ?, ?) ON CONFLICT(creative_id, region_id) DO UPDATE SET
            first_shown = coalesce(min(first_shown, excluded.first_shown), first_shown, excluded.first_shown),
            last_shown = max(last_shown, excluded.last_shown)`, cr, regionId, firstShown ?? null, lastShown);
        }
        run('UPDATE creatives SET regions_checked_at = ?, regions_retry = 0 WHERE id = ?', new Date(now).toISOString(), cr);
      });
    },
    creativesNeedingRegions(limit, { watchId = null, now = new Date() } = {}) {
      const at = new Date(now).toISOString();
      const cutoff = new Date(Date.parse(at) - 2 * DAY).toISOString();
      const refresh = new Date(Date.parse(at) - 7 * DAY).toISOString();
      const source = watchId ? 'watch_creatives wc JOIN creatives c ON c.id = wc.creative_id' : 'creatives c';
      const seen = watchId ? 'wc.first_seen' : 'c.first_seen_by_us';
      const shown = watchId ? 'wc.last_shown' : 'c.last_shown';
      const where = watchId ? "wc.watch_id = ? AND wc.platform = 'search'" : "c.platform = 'search'";
      return all(`SELECT c.id AS creativeId, c.advertiser_id AS advertiserId FROM ${source}
        WHERE ${where} AND c.advertiser_id IS NOT NULL
          AND (c.regions_retry = 1 OR (c.regions_checked_at IS NULL AND (${seen} = ? OR ${shown} >= ?))
            OR (c.regions_checked_at <= ? AND ${shown} >= ?))
        ORDER BY (${seen} = ?) DESC, c.regions_checked_at, ${seen} DESC, c.id LIMIT ?`,
      ...(watchId ? [watchId, at, cutoff, refresh, cutoff, at, limit] : [at, cutoff, refresh, cutoff, at, limit]))
        .map(row => ({ ...row }));
    },
    ...createTimeReport({ all, scanHistory }),
    getLastScan() {
      const history = getScanLog();
      const last = history.at(-1);
      if (!last) return null;
      const { resumeAt: storedResume, ...entry } = last;
      const resumeAt = scanResumeAt(history);
      return resumeAt ? { ...entry, resumeAt } : entry;
    },
    getScanningWatchId() {
      const scan = get("SELECT status, entry FROM scans ORDER BY id DESC LIMIT 1");
      return scan?.status === 'running' ? JSON.parse(scan.entry).watchId ?? null : null;
    },
    suggest(q) {
      return all(`WITH suggestions AS (
        SELECT 'advertiser' AS type, a.id AS value, coalesce(nullif(a.name, ''), a.id) AS name, count(*) AS ads
        FROM creatives c JOIN advertisers a ON a.id = c.advertiser_id
        WHERE instr(fold_name(a.name), fold_name(?)) OR instr(fold_name(a.id), fold_name(?))
        GROUP BY a.id
        UNION ALL
        SELECT 'domain', domain_key(domain), NULL, count(*) FROM creatives
        WHERE domain_key(domain) != '' AND instr(domain_key(domain), fold_name(?))
        GROUP BY domain_key(domain)
      ) SELECT * FROM suggestions ORDER BY ads DESC, value, type LIMIT 10`, q, q, q)
        .map(({ name, ...row }) => name == null ? row : { ...row, name });
    },
    listAdsForProfile(pid, { filter = 'all', q = '', format = '', watchId = '', group, from, to } = {}, now = new Date()) {
      const range = from != null || to != null ? adsDateRange(all, pid, watchId || null, { from, to }, now) : null;
      const currentTime = new Date(now).getTime();
      const query = q.trim().toLowerCase();
      const creatives = new Map();
      for (const watch of getWatchlist(pid)) {
        if (watchId && watch.id !== watchId) continue;
        const file = getAds(watch.id);
        if (!file) continue;
        for (const ad of Object.values(file.ads)) {
          if (ad.platform !== 'search') continue;
          if (group != null && groupIdentity(ad, groupTypeFor(watch.kind)).key !== group) continue;
          if (range) {
            const firstDay = vietnamDate(ad.firstShown);
            const lastDay = vietnamDate(ad.lastShown);
            if (!firstDay || !lastDay || firstDay > lastDay || firstDay > range.to || lastDay < range.from) continue;
          }
          const existing = creatives.get(ad.creativeId);
          const watchIds = existing?.watchIds ?? [];
          const watchLabels = existing?.watchLabels ?? [];
          watchIds.push(watch.id);
          if (!watchLabels.includes(watch.label)) watchLabels.push(watch.label);
          const seen = Date.parse(ad.firstSeenByUs);
          if (existing && seen >= Date.parse(existing.firstSeenByUs)) continue;
          creatives.set(ad.creativeId, {
            ...ad, watchId: watch.id, watchLabel: watch.label, watchKind: watch.kind, watchIds, watchLabels,
            isNew: seen >= currentTime - DAY && seen <= currentTime,
            isRunning: runningAt(ad.lastShown, Date.parse(file.lastScanAt)),
          });
        }
      }
      const byCreative = regionsByCreative(all(`SELECT r.creative_id AS creativeId,
        r.region_id AS regionId, r.last_shown AS lastShown FROM creative_regions r
        JOIN (SELECT DISTINCT wc.creative_id FROM profile_watches p
          JOIN watch_creatives wc ON wc.watch_id = p.watch_id
          WHERE p.profile_id = ? AND wc.platform = 'search') matches ON matches.creative_id = r.creative_id
        ORDER BY r.region_id`, pid));
      return [...creatives.values()].filter((ad) => {
        if (filter === 'new' && !ad.isNew) return false;
        if (filter === 'running' && !ad.isRunning) return false;
        if (filter === 'stopped' && ad.isRunning) return false;
        if (format && ad.format !== format) return false;
        return !query || [ad.domain, ad.advertiserName, ...ad.watchLabels].some(
          (value) => value?.toLowerCase().includes(query),
        );
      }).sort((a, b) => Date.parse(b.firstSeenByUs) - Date.parse(a.firstSeenByUs))
        .map(ad => ({ ...ad, regions: byCreative.get(ad.creativeId) ?? [] }));
    },
    imagesDir() {
      const directory = resolve(data, 'images');
      if (!options?.readOnly) mkdirSync(directory, { recursive: true });
      return directory;
    },
  };
}
