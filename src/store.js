import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWatchInput, regionIdToIso, slugify } from './atc.js';
import { openDb, TRASH_RETENTION_MS } from './db.js';
import { groupIdentity, runningAt } from './groups.js';
import { adsDateRange, createTimeReport, vietnamDate } from './time-report.js';
import { scanResumeAt } from './scan-rest.js';
import { createWebStore } from './web-store.js';

const DAY = 24 * 60 * 60 * 1000;
const missingDomain = "coalesce(trim(domain), '') = ''";
const ocrDue = '(domain_ocr_attempted_at IS NULL OR domain_ocr_attempted_at <= ?)';
const ocrCutoff = at => new Date(+new Date(at) - 7 * DAY).toISOString();
const watchFields = 'w.id, w.type, w.value, w.region, p.label, p.kind, p.added_at AS addedAt, p.group_id AS groupId';
const groupTypeFor = (kind) => kind === 'project' ? 'advertiser' : 'domain';
const kindForWatchType = (type) => type === 'domain' ? 'project' : 'competitor';

function notFound(message) {
  return Object.assign(new Error(message), { code: 'NOT_FOUND' });
}

function groupName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Vui lòng nhập tên nhóm.');
  return name.trim();
}

function watchKind(kind) {
  if (kind !== 'competitor' && kind !== 'project') throw new Error('Loại theo dõi không hợp lệ.');
  return kind;
}

function pathId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/i.test(id)) throw new Error('Mã không hợp lệ');
  return id;
}

export function createStore(root, options) {
  const data = resolve(root, 'data');
  const { run, get, all, transaction, ensureWatch, linkWatch, saveAd, saveScan, saveSnapshot, purgeExpiredTrash, close } =
    openDb(data, options);
  const now = options?.now ?? (() => new Date());
  function requireProfile(pid) {
    if (!get('SELECT 1 FROM profiles WHERE id = ?', pathId(pid))) throw notFound('Không tìm thấy hồ sơ.');
  }

  function requireGroup(pid, gid) {
    const group = get(`SELECT id, name, kind, created_at AS createdAt FROM watch_groups
      WHERE profile_id = ? AND id = ?`, pid, pathId(gid));
    if (!group) throw notFound('Không tìm thấy nhóm.');
    return { ...group };
  }

  function validateGroup(pid, gid, kind) {
    if (gid !== null && requireGroup(pid, gid).kind !== kind) {
      throw new Error('Nhóm này thuộc loại khác');
    }
  }

  function changeTrash(pid, ids, action) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('Vui lòng chọn mục theo dõi.');
    const unique = new Set(ids.map(pathId));
    return transaction(() => {
      requireProfile(pid);
      const deletedAt = new Date(now()).toISOString();
      const cutoff = new Date(Date.parse(deletedAt) - TRASH_RETENTION_MS).toISOString();
      for (const id of unique) {
        const result = action === 'delete'
          ? run(`UPDATE profile_watches SET deleted_at = ?
              WHERE profile_id = ? AND watch_id = ? AND deleted_at IS NULL`, deletedAt, pid, id)
          : action === 'restore'
            ? run(`UPDATE profile_watches SET deleted_at = NULL
                WHERE profile_id = ? AND watch_id = ? AND deleted_at >= ?`, pid, id, cutoff)
            : run(`DELETE FROM profile_watches
                WHERE profile_id = ? AND watch_id = ? AND deleted_at IS NOT NULL`, pid, id);
        if (!result.changes) throw notFound('Không tìm thấy mục theo dõi.');
      }
    });
  }

  const listProfiles = () => all('SELECT id, name, created_at AS createdAt FROM profiles ORDER BY rowid')
    .map(row => ({ ...row }));
  const getWatchlist = (pid) => all(`SELECT ${watchFields} FROM profile_watches p
    JOIN watches w ON w.id = p.watch_id WHERE p.profile_id = ? AND p.deleted_at IS NULL ORDER BY p.rowid`, pathId(pid))
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
    getGroups(pid) {
      requireProfile(pid);
      return all(`SELECT id, name, kind, created_at AS createdAt FROM watch_groups
        WHERE profile_id = ? ORDER BY rowid`, pid).map(row => ({ ...row }));
    },
    addGroup(pid, name, kind) {
      const group = { id: randomUUID(), name: groupName(name), kind: watchKind(kind), createdAt: new Date(now()).toISOString() };
      return transaction(() => {
        requireProfile(pid);
        run('INSERT INTO watch_groups VALUES (?, ?, ?, ?, ?)', group.id, pid, group.name, group.kind, group.createdAt);
        return group;
      });
    },
    renameGroup(pid, gid, name) {
      name = groupName(name);
      return transaction(() => {
        const group = requireGroup(pathId(pid), gid);
        run('UPDATE watch_groups SET name = ? WHERE id = ?', name, gid);
        return { ...group, name };
      });
    },
    removeGroup(pid, gid) {
      return transaction(() => {
        requireGroup(pathId(pid), gid);
        run('DELETE FROM watch_groups WHERE id = ?', gid);
      });
    },
    addWatch(pid, input, region = null, _kind, groupId) {
      return transaction(() => {
        requireProfile(pid);
        const addedAt = new Date(now()).toISOString();
        purgeExpiredTrash(addedAt);
        let parsed;
        try {
          parsed = parseWatchInput(input);
        } catch (error) {
          const named = get(`SELECT a.id FROM advertisers a JOIN creatives c ON c.advertiser_id = a.id
            WHERE fold_name(a.name) = fold_name(?) AND fold_name(a.name) != ''
            GROUP BY a.id ORDER BY count(*) DESC, a.id LIMIT 1`, input);
          if (!named) throw error;
          parsed = { type: 'advertiser', value: named.id };
        }
        const { type, value } = parsed;
        const label = type === 'advertiser'
          ? get('SELECT name FROM advertisers WHERE id = ?', value)?.name || value : value;
        const existing = get(`SELECT ${watchFields}, p.deleted_at AS deletedAt FROM profile_watches p
          JOIN watches w ON w.id = p.watch_id WHERE p.profile_id = ? AND w.type = ?
          AND w.value = ? AND w.region IS ?`, pid, type, value, region);
        const nextKind = kindForWatchType(type);
        const nextGroup = groupId === undefined
          ? (existing?.kind === nextKind ? existing.groupId : null) : groupId;
        validateGroup(pid, nextGroup, nextKind);
        if (existing) {
          run(`UPDATE profile_watches SET kind = ?, group_id = ?, deleted_at = NULL
            WHERE profile_id = ? AND watch_id = ?`, nextKind, nextGroup, pid, existing.id);
          const { deletedAt, ...watch } = existing;
          return { ...watch, kind: nextKind, groupId: nextGroup };
        }

        const base = pathId(region == null ? slugify(value) : `${slugify(value)}-r${region}`);
        const shared = get('SELECT id FROM watches WHERE type = ? AND value = ? AND region IS ? LIMIT 1',
          type, value, region);
        let id = shared?.id ?? base;
        if (!shared) {
          for (let suffix = 2; get('SELECT 1 FROM watches WHERE id = ?', id); suffix++) id = `${base}-${suffix}`;
        }
        const watch = { id, type, value, label, region, kind: nextKind, addedAt, groupId: nextGroup };
        linkWatch(pid, watch);
        if (nextGroup !== null) {
          run('UPDATE profile_watches SET group_id = ? WHERE profile_id = ? AND watch_id = ?', nextGroup, pid, id);
        }
        return watch;
      });
    },
    setWatchGroup(pid, wid, groupId) {
      return transaction(() => {
        const watch = get(`SELECT ${watchFields} FROM profile_watches p JOIN watches w ON w.id = p.watch_id
          WHERE p.profile_id = ? AND p.watch_id = ? AND p.deleted_at IS NULL`, pathId(pid), pathId(wid));
        if (!watch) throw notFound('Không tìm thấy mục theo dõi.');
        validateGroup(pid, groupId, watch.kind);
        run('UPDATE profile_watches SET group_id = ? WHERE profile_id = ? AND watch_id = ?', groupId, pid, wid);
        return { ...watch, groupId };
      });
    },
    removeWatch: (pid, wid) => changeTrash(pid, [wid], 'delete'),
    removeWatches: (pid, ids) => changeTrash(pid, ids, 'delete'),
    restoreWatches: (pid, ids) => changeTrash(pid, ids, 'restore'),
    purgeWatches: (pid, ids) => changeTrash(pid, ids, 'purge'),
    purgeExpiredTrash,
    getTrash(pid) {
      requireProfile(pid);
      const cutoff = new Date(+new Date(now()) - TRASH_RETENTION_MS).toISOString();
      return all(`SELECT watch_id AS watchId, label, kind, group_id AS groupId, deleted_at AS deletedAt
        FROM profile_watches WHERE profile_id = ? AND deleted_at >= ? ORDER BY deleted_at DESC, rowid DESC`,
      pid, cutoff).map(row => ({
        ...row, purgeAt: new Date(Date.parse(row.deletedAt) + TRASH_RETENTION_MS).toISOString(),
      }));
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
    isWatchActive(wid) {
      return Boolean(get('SELECT 1 FROM profile_watches WHERE watch_id = ? AND deleted_at IS NULL LIMIT 1', wid));
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
          const suppliedDomain = raw.domain?.trim();
          const storedDomain = get('SELECT domain, domain_source FROM creatives WHERE id = ?', raw.creativeId);
          const domain = suppliedDomain || previous?.domain || storedDomain?.domain;
          if (domain) ad.domain = domain;
          saveAd(watch.id, ad, suppliedDomain || null);
          if (suppliedDomain && storedDomain?.domain_source && suppliedDomain !== storedDomain.domain) {
            run('UPDATE creatives SET domain_source = NULL WHERE id = ?', raw.creativeId);
          }
          ads[raw.creativeId] = ad;
        }
        const savedLabel = previousFile?.watch.label;
        const advertiserName = savedLabel && savedLabel !== watch.value
          ? savedLabel : rawAds[0]?.advertiserName?.trim();
        const label = watch.type === 'advertiser' && watch.label === watch.value && advertiserName
          ? advertiserName : watch.label;
        run('UPDATE watches SET last_scan_at = ?, label = ?, kind = ? WHERE id = ?',
          lastScanAt, label, kindForWatchType(watch.type), watch.id);
        if (watch.type === 'advertiser' && label !== watch.value) {
          run('UPDATE profile_watches SET label = ? WHERE watch_id = ? AND label = ?', label, watch.id, watch.value);
        }
        if (scanId != null) saveSnapshot(scanId, watch.id, lastScanAt, Object.values(ads));
        const { groupId, ...sharedWatch } = watch;
        return { file: { watch: { ...sharedWatch, label }, lastScanAt, ads: { ...ads } }, newIds };
      });
    },
    setCreativeDomain(creativeId, domain, source = 'ocr') {
      return transaction(() => {
        if (!get(`SELECT 1 FROM creatives WHERE id = ? AND ${missingDomain}`, creativeId)) return false;
        run('INSERT OR IGNORE INTO domains VALUES (?)', domain);
        run('UPDATE creatives SET domain = ?, domain_source = ? WHERE id = ?', domain, source, creativeId);
        run(`UPDATE watch_creatives SET observation = json_set(observation, '$.domain', ?)
          WHERE creative_id = ?`, domain, creativeId);
        return true;
      });
    },
    creativesNeedingDomains(limit, { watchId = null, now: at = now(), remoteOnly = false, localOnly = false } = {}) {
      const legacyImage = "preview_url GLOB 'https://tpc.googlesyndication.com/archive/simgad/*'";
      const remoteImage = `coalesce(nullif(trim(image_url), ''), CASE WHEN ${legacyImage} THEN preview_url END)`;
      const imageFilter = localOnly ? 'image IS NOT NULL'
        : `${remoteImage} IS NOT NULL ${remoteOnly ? '' : 'OR image IS NOT NULL'}`;
      const watchFilter = watchId == null ? '' : `AND EXISTS (
        SELECT 1 FROM watch_creatives WHERE watch_id = ? AND creative_id = c.id)`;
      return all(`SELECT id AS creativeId, image, ${remoteImage} AS imageUrl FROM creatives c
        WHERE ${missingDomain} AND ${ocrDue}
          AND (${imageFilter})
          ${watchFilter}
        ORDER BY domain_ocr_attempted_at, first_seen_by_us DESC, id LIMIT ?`,
      ocrCutoff(at), ...(watchId == null ? [] : [watchId]), limit);
    },
    creativesNeedingPreviewDomains(limit, { now: at = now() } = {}) {
      return all(`SELECT id AS creativeId, preview_url AS previewUrl FROM creatives
        WHERE ${missingDomain} AND ${ocrDue}
          AND preview_url GLOB 'https://displayads-formats.googleusercontent.com/*content.js*'
        ORDER BY domain_ocr_attempted_at, first_seen_by_us DESC, id LIMIT ?`, ocrCutoff(at), limit);
    },
    claimDomainOcr(creativeId, at = now()) {
      return Boolean(transaction(() => run(`UPDATE creatives SET domain_ocr_attempted_at = ?
        WHERE id = ? AND ${missingDomain} AND ${ocrDue}`,
      new Date(at).toISOString(), creativeId, ocrCutoff(at)).changes));
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
      return all(`WITH active_creatives AS (
        SELECT DISTINCT wc.creative_id FROM watch_creatives wc
        JOIN profile_watches p ON p.watch_id = wc.watch_id WHERE p.deleted_at IS NULL
      ), suggestions AS (
        SELECT 'advertiser' AS type, a.id AS value, coalesce(nullif(a.name, ''), a.id) AS name, count(*) AS ads
        FROM active_creatives ac JOIN creatives c ON c.id = ac.creative_id
        JOIN advertisers a ON a.id = c.advertiser_id
        WHERE instr(fold_name(a.name), fold_name(?)) OR instr(fold_name(a.id), fold_name(?))
        GROUP BY a.id
        UNION ALL
        SELECT 'domain', domain_key(domain), NULL, count(*) FROM active_creatives ac JOIN creatives c ON c.id = ac.creative_id
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
          WHERE p.profile_id = ? AND p.deleted_at IS NULL AND wc.platform = 'search') matches ON matches.creative_id = r.creative_id
        ORDER BY r.region_id`, pid));
      const sources = new Map(all(`SELECT id, domain, domain_source AS domainSource FROM creatives
        WHERE domain_source IS NOT NULL`).map(row => [row.id, row]));
      return [...creatives.values()].filter((ad) => {
        if (filter === 'new' && !ad.isNew) return false;
        if (filter === 'running' && !ad.isRunning) return false;
        if (filter === 'stopped' && ad.isRunning) return false;
        if (format && ad.format !== format) return false;
        return !query || [ad.domain, ad.advertiserName, ...ad.watchLabels].some(
          (value) => value?.toLowerCase().includes(query),
        );
      }).sort((a, b) => Date.parse(b.firstSeenByUs) - Date.parse(a.firstSeenByUs))
        .map(ad => {
          const source = sources.get(ad.creativeId);
          return { ...ad, ...(source ? { domain: source.domain ?? ad.domain, domainSource: source.domainSource } : {}),
            regions: byCreative.get(ad.creativeId) ?? [] };
        });
    },
    imagesDir() {
      const directory = resolve(data, 'images');
      if (!options?.readOnly) mkdirSync(directory, { recursive: true });
      return directory;
    },
  };
}
