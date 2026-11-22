import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWatchInput, regionIdToIso, slugify } from './atc.js';
import { openDb } from './db.js';

const DAY = 24 * 60 * 60 * 1000;
const groupOrder = ['new', 'increase', 'decrease', 'stopped', 'steady'];
const watchFields = 'w.id, w.type, w.value, w.region, p.label, p.kind, p.added_at AS addedAt';
const runningAt = (lastShown, at) => Date.parse(lastShown) >= at - 2 * DAY;
const groupTypeFor = (kind) => kind === 'project' ? 'advertiser' : 'domain';

function pathId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/i.test(id)) throw new Error('Mã không hợp lệ');
  return id;
}

function groupIdentity(ad, groupType) {
  if (groupType === 'advertiser') {
    return { key: ad.advertiserId || '', name: ad.advertiserName || ad.advertiserId || 'Chưa rõ nhà quảng cáo' };
  }
  const key = ad.domain?.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || '';
  return { key, name: key || 'Chưa rõ tên miền' };
}

function groupAds(ads, groupType) {
  const groups = new Map();
  for (const ad of ads) {
    if (ad.platform !== 'search') continue;
    const { key, name } = groupIdentity(ad, groupType);
    if (!groups.has(key)) groups.set(key, { key, name, ads: [] });
    groups.get(key).ads.push(ad);
  }
  return groups.values();
}

export function createStore(root) {
  const data = resolve(root, 'data');
  const { run, get, all, transaction, ensureWatch, linkWatch, saveAd, saveScan } = openDb(data);
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

  const getScanLog = () => all('SELECT entry FROM scans ORDER BY id DESC LIMIT 30')
    .reverse().map(({ entry }) => JSON.parse(entry));
  const getRegions = (id) => all(`SELECT region_id AS regionId, last_shown AS lastShown
    FROM creative_regions WHERE creative_id = ? ORDER BY region_id`, id)
    .map(({ regionId, lastShown }) => ({ regionId, iso: regionIdToIso(regionId), lastShown }));

  function labelAd(ad, watch) {
    return {
      ...ad, watchId: watch.id, watchLabel: watch.label, watchKind: watch.kind,
      regions: getRegions(ad.creativeId),
    };
  }

  return {
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
      run('DELETE FROM profile_watches WHERE profile_id = ? AND watch_id = ?', pathId(pid), wid);
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
    mergeAds(watch, rawAds, now) {
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
            lastShown: raw.lastShown ?? previous?.lastShown ?? null,
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
        return { file: getAds(watch.id), newIds };
      });
    },
    setAdImage(wid, cr, relPath) {
      run(`UPDATE creatives SET image = ? WHERE id = ? AND EXISTS (
        SELECT 1 FROM watch_creatives WHERE watch_id = ? AND creative_id = ?)`, relPath, cr, pathId(wid), cr);
    },
    appendScanLog(entry) {
      return saveScan(entry);
    },
    setScanSync(scanId, sync) {
      const { entry } = get('SELECT entry FROM scans WHERE id = ?', scanId);
      run('UPDATE scans SET sync = ?, entry = ? WHERE id = ?',
        JSON.stringify(sync), JSON.stringify({ ...JSON.parse(entry), sync }), scanId);
    },
    checkpoint() {
      return get('PRAGMA wal_checkpoint(TRUNCATE)').busy === 0;
    },
    getScanLog,
    setCreativeRegions(cr, regions) {
      transaction(() => {
        run('DELETE FROM creative_regions WHERE creative_id = ?', cr);
        for (const { regionId, firstShown, lastShown } of regions) {
          run(`INSERT INTO creative_regions (creative_id, region_id, first_shown, last_shown)
            VALUES (?, ?, ?, ?) ON CONFLICT(creative_id, region_id) DO UPDATE SET
            first_shown = coalesce(min(first_shown, excluded.first_shown), first_shown, excluded.first_shown),
            last_shown = max(last_shown, excluded.last_shown)`, cr, regionId, firstShown ?? null, lastShown);
        }
        run('UPDATE creatives SET regions_checked_at = ? WHERE id = ?', new Date().toISOString(), cr);
      });
    },
    creativesNeedingRegions(limit, { watchId = null, now = new Date() } = {}) {
      const at = new Date(now).toISOString();
      const cutoff = new Date(Date.parse(at) - 2 * DAY).toISOString();
      const conditions = watchId
        ? `AND EXISTS (SELECT 1 FROM watch_creatives wc
          WHERE wc.creative_id = c.id AND wc.watch_id = ? AND
          (julianday(json_extract(wc.observation, '$.firstSeenByUs')) = julianday(?)
            OR julianday(json_extract(wc.observation, '$.lastShown')) >= julianday(?)))`
        : 'AND (julianday(c.first_seen_by_us) = julianday(?) OR julianday(c.last_shown) >= julianday(?))';
      const priority = watchId
        ? `(SELECT julianday(json_extract(wc.observation, '$.firstSeenByUs')) FROM watch_creatives wc
            WHERE wc.creative_id = c.id AND wc.watch_id = ?)`
        : 'julianday(c.first_seen_by_us)';
      return all(`SELECT c.id AS creativeId, c.advertiser_id AS advertiserId FROM creatives c
        WHERE c.platform = 'search' AND c.advertiser_id IS NOT NULL AND c.regions_checked_at IS NULL
        ${conditions} ORDER BY (${priority} = julianday(?)) DESC, c.first_seen_by_us DESC, c.id LIMIT ?`,
      ...(watchId ? [watchId, at, cutoff, watchId, at, limit] : [at, cutoff, at, limit]))
        .map(row => ({ ...row }));
    },
    recordGroupSnapshots(scanId, now) {
      transaction(() => {
        run('DELETE FROM group_snapshots WHERE scan_id = ?', scanId);
        for (const { id } of all('SELECT DISTINCT watch_id AS id FROM profile_watches')) {
          const file = getAds(id);
          if (!file) continue;
          // Watches skipped by a partial scan retain their last observed counts.
          const at = Math.min(Date.parse(file.lastScanAt), new Date(now).getTime());
          for (const type of ['domain', 'advertiser']) {
            for (const { key, ads } of groupAds(Object.values(file.ads), type)) {
              const running = ads.filter(ad => runningAt(ad.lastShown, at)).length;
              run('INSERT INTO group_snapshots VALUES (?, ?, ?, ?, ?, ?)', scanId, id, type, key, running, ads.length);
            }
          }
        }
        run('UPDATE scans SET has_snapshots = 1 WHERE id = ?', scanId);
      });
    },
    getSummary(pid, now) {
      const cutoff = new Date(now ?? Date.now()).toISOString();
      const [latest, previous] = all(`SELECT id, at, status, has_snapshots FROM scans
        WHERE status IN ('ok', 'blocked') AND julianday(at) <= julianday(?)
        ORDER BY id DESC LIMIT 2`, cutoff);
      const baseline = latest && get(`SELECT id FROM scans WHERE id < ? AND has_snapshots = 1
        AND status IN ('ok', 'blocked') ORDER BY id DESC LIMIT 1`, latest.id);
      const totals = { newGroups: 0, increased: 0, decreased: 0, stopped: 0, runningAds: 0 };
      const statusTotals = { new: 'newGroups', increase: 'increased', decrease: 'decreased', stopped: 'stopped' };
      const watches = getWatchlist(pid).map(watch => {
        const file = getAds(watch.id);
        const groupType = groupTypeFor(watch.kind);
        const at = new Date(now ?? file?.lastScanAt ?? latest?.at ?? cutoff).getTime();
        const prior = new Map((baseline ? all(`SELECT group_key, running FROM group_snapshots
          WHERE scan_id = ? AND watch_id = ? AND group_type = ?`, baseline.id, watch.id, groupType) : [])
          .map(row => [row.group_key, row.running]));
        const historical = new Set((latest ? all(`SELECT DISTINCT group_key FROM group_snapshots
          WHERE scan_id < ? AND watch_id = ? AND group_type = ?`, latest.id, watch.id, groupType) : [])
          .map(row => row.group_key));
        const groups = [];
        for (const { key, name, ads } of groupAds(Object.values(file?.ads ?? {}), groupType)) {
          ads.sort((a, b) => Date.parse(b.firstSeenByUs) - Date.parse(a.firstSeenByUs));
          const runningNow = ads.filter(ad => runningAt(ad.lastShown, at)).length;
          const runningBefore = prior.get(key) ?? 0;
          const delta = runningNow - runningBefore;
          let status = 'steady';
          if (!historical.has(key)) status = 'new';
          else if (delta > 0) status = 'increase';
          else if (delta < 0) status = runningNow === 0 ? 'stopped' : 'decrease';
          const regionsById = new Map();
          for (const ad of ads) {
            for (const region of getRegions(ad.creativeId)) {
              if (!runningAt(region.lastShown, at)) continue;
              const entry = regionsById.get(region.regionId) ?? { regionId: region.regionId, iso: region.iso, running: 0 };
              entry.running++;
              regionsById.set(region.regionId, entry);
            }
          }
          const regions = [...regionsById.values()].sort((a, b) => b.running - a.running || a.regionId - b.regionId);
          const previousAt = Date.parse(previous?.at);
          const newAds = ads.filter(ad => !previous || Date.parse(ad.firstSeenByUs) > previousAt).length;
          groups.push({ key, name, groupType, status, runningNow, runningBefore, delta, newAds,
            totalAds: ads.length, firstSeen: ads.at(-1).firstSeenByUs, regions,
            sampleAds: ads.slice(0, 4).map(ad => labelAd(ad, watch)) });
          if (statusTotals[status]) totals[statusTotals[status]]++;
          totals.runningAds += runningNow;
        }
        groups.sort((a, b) => groupOrder.indexOf(a.status) - groupOrder.indexOf(b.status)
          || Math.abs(b.delta) - Math.abs(a.delta));
        return { watchId: watch.id, label: watch.label, kind: watch.kind,
          runningNow: groups.reduce((sum, group) => sum + group.runningNow, 0),
          runningBefore: [...prior.values()].reduce((sum, running) => sum + running, 0), groups };
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
      return [...creatives.values()].filter((ad) => {
        if (filter === 'new' && !ad.isNew) return false;
        if (filter === 'running' && !ad.isRunning) return false;
        if (filter === 'stopped' && ad.isRunning) return false;
        if (format && ad.format !== format) return false;
        return !query || [ad.domain, ad.advertiserName, ...ad.watchLabels].some(
          (value) => value?.toLowerCase().includes(query),
        );
      }).sort((a, b) => Date.parse(b.firstSeenByUs) - Date.parse(a.firstSeenByUs))
        .map(ad => ({ ...ad, regions: getRegions(ad.creativeId) }));
    },
    imagesDir() {
      const directory = resolve(data, 'images');
      mkdirSync(directory, { recursive: true });
      return directory;
    },
  };
}
