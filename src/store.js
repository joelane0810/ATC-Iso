import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWatchInput, regionIdToIso, slugify } from './atc.js';
import { openDb } from './db.js';
import { groupAds, groupIdentity, runningAt } from './groups.js';
import { createWebStore } from './web-store.js';

const DAY = 24 * 60 * 60 * 1000;
const groupOrder = ['new', 'increase', 'decrease', 'stopped', 'steady'];
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

  const getScanLog = () => all("SELECT entry FROM scans WHERE status IS NOT NULL AND status != 'running' ORDER BY id DESC LIMIT 30")
    .reverse().map(({ entry }) => JSON.parse(entry));
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
      const { type, value } = parseWatchInput(input);
      return transaction(() => {
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
        const watch = { id, type, value, label: value, region, kind, addedAt: new Date().toISOString() };
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
    beginScan(at) {
      return transaction(() => saveScan({ at, status: 'running' }));
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
    getSummary(pid, now) {
      const cutoff = new Date(now ?? Date.now()).toISOString();
      const [latest, previous] = all(`SELECT id, at, status FROM scans
        WHERE status IN ('ok', 'blocked', 'error') AND julianday(at) <= julianday(?) ORDER BY id DESC LIMIT 2`, cutoff);
      const currentScan = get(`SELECT id FROM scans WHERE status IS NOT NULL AND status != 'cooldown' AND julianday(at) <= julianday(?) ORDER BY id DESC LIMIT 1`, cutoff);
      const totals = { newGroups: 0, increased: 0, decreased: 0, stopped: 0, runningAds: 0 };
      const statusTotals = { new: 'newGroups', increase: 'increased', decrease: 'decreased', stopped: 'stopped' };
      const watches = getWatchlist(pid).map(watch => {
        const file = getAds(watch.id);
        const groupType = groupTypeFor(watch.kind);
        const [current, prior] = all(`SELECT ws.scan_id, ws.at, s.status FROM watch_scans ws
          JOIN scans s ON s.id = ws.scan_id WHERE ws.watch_id = ? AND julianday(ws.at) <= julianday(?)
          ORDER BY ws.scan_id DESC LIMIT 2`, watch.id, cutoff);
        const snapshot = scan => new Map((scan ? all(`SELECT group_key, name, running, total
          FROM group_snapshots WHERE scan_id = ? AND watch_id = ? AND group_type = ?`,
        scan.scan_id, watch.id, groupType) : []).map(row => [row.group_key, row]));
        const currentGroups = snapshot(current);
        const priorGroups = snapshot(prior);
        const skipped = current && (current.status == null || current.scan_id < currentScan?.id);
        const historical = new Set((current ? all(`SELECT DISTINCT group_key FROM group_snapshots
          WHERE scan_id < ? AND watch_id = ? AND group_type = ?`, current.scan_id, watch.id, groupType) : [])
          .map(row => row.group_key));
        const live = file?.lastScanAt === current?.at
          ? groupAds(Object.values(file?.ads ?? {}), groupType) : new Map();
        const regionCutoff = new Date(Date.parse(current?.at ?? cutoff) - 2 * DAY).toISOString().slice(0, 10);
        const byCreative = regionsByCreative(all(`SELECT wc.creative_id AS creativeId,
          r.region_id AS regionId, r.last_shown AS lastShown FROM watch_creatives wc
          JOIN creative_regions r ON r.creative_id = wc.creative_id
          WHERE wc.watch_id = ? AND wc.platform = 'search' ORDER BY r.region_id`, watch.id));
        const groups = [];
        for (const key of new Set([...currentGroups.keys(), ...priorGroups.keys()])) {
          const currentGroup = currentGroups.get(key);
          const priorGroup = priorGroups.get(key);
          const ads = live.get(key)?.ads ?? [];
          ads.sort((a, b) => Date.parse(b.firstSeenByUs) - Date.parse(a.firstSeenByUs));
          const runningNow = currentGroup?.running ?? 0;
          const runningBefore = skipped ? runningNow : priorGroup?.running ?? 0;
          const delta = runningNow - runningBefore;
          let status = 'steady';
          if (!skipped && !historical.has(key)) status = 'new';
          else if (delta > 0) status = 'increase';
          else if (delta < 0) status = runningNow === 0 ? 'stopped' : 'decrease';
          const regionsById = new Map();
          for (const ad of ads) {
            for (const region of byCreative.get(ad.creativeId) ?? []) {
              if (region.lastShown.slice(0, 10) < regionCutoff) continue;
              const entry = regionsById.get(region.regionId) ?? { regionId: region.regionId, iso: region.iso, running: 0 };
              entry.running++;
              regionsById.set(region.regionId, entry);
            }
          }
          const regions = [...regionsById.values()].sort((a, b) => b.running - a.running || a.regionId - b.regionId);
          const newAds = skipped ? 0 : ads.filter(ad => !prior || Date.parse(ad.firstSeenByUs) > Date.parse(prior.at)).length;
          groups.push({ key, name: currentGroup?.name ?? live.get(key)?.name ?? priorGroup?.name ?? (key || 'Chưa rõ'),
            groupType, status, runningNow, runningBefore, delta, newAds,
            totalAds: currentGroup?.total ?? 0, firstSeen: ads.at(-1)?.firstSeenByUs ?? null, regions,
            sampleAds: ads.slice(0, 4).map(ad => ({ ...ad, watchId: watch.id, watchLabel: watch.label,
              watchKind: watch.kind, regions: byCreative.get(ad.creativeId) ?? [] })) });
          if (statusTotals[status]) totals[statusTotals[status]]++;
          totals.runningAds += runningNow;
        }
        groups.sort((a, b) => groupOrder.indexOf(a.status) - groupOrder.indexOf(b.status)
          || Math.abs(b.delta) - Math.abs(a.delta));
        return { watchId: watch.id, label: watch.label, kind: watch.kind,
          runningNow: groups.reduce((sum, group) => sum + group.runningNow, 0),
          runningBefore: groups.reduce((sum, group) => sum + group.runningBefore, 0), groups };
      });
      return { lastScan: latest ? { at: latest.at, status: latest.status } : null,
        previousScanAt: previous?.at ?? null, totals, watches };
    },
    listAdsForProfile(pid, { filter = 'all', q = '', format = '', watchId = '', group } = {}, now = new Date()) {
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
