import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseWatchInput, slugify } from './atc.js';

const DAY = 24 * 60 * 60 * 1000;

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function pathId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/i.test(id)) {
    throw new Error('Mã không hợp lệ');
  }
  return id;
}

export function createStore(root) {
  const data = resolve(root, 'data');
  const profilesPath = resolve(data, 'profiles.json');
  const logPath = resolve(data, 'scan-log.json');
  const watchlistPath = (pid) => resolve(data, 'profiles', pathId(pid), 'watchlist.json');
  const adsPath = (wid) => resolve(data, 'ads', `${pathId(wid)}.json`);

  const listProfiles = () => readJson(profilesPath, []);
  const getWatchlist = (pid) => readJson(watchlistPath(pid), []);
  const getAds = (wid) => readJson(adsPath(wid), null);
  const getScanLog = () => readJson(logPath, []);

  return {
    listProfiles,
    addProfile(name) {
      const profiles = listProfiles();
      name = name.trim();
      if (!name) throw new Error('Vui lòng nhập tên hồ sơ');
      const base = slugify(name) || 'ho-so';
      let id = base;
      for (let suffix = 2; profiles.some((profile) => profile.id === id); suffix++) {
        id = `${base}-${suffix}`;
      }
      const profile = { id, name, createdAt: new Date().toISOString() };
      writeJson(profilesPath, [...profiles, profile]);
      return profile;
    },
    getWatchlist,
    addWatch(pid, input, region = null) {
      const watches = getWatchlist(pid);
      const { type, value } = parseWatchInput(input);
      const existing = watches.find((watch) => watch.type === type && watch.value === value && watch.region === region);
      if (existing) return existing;

      const id = pathId(region == null ? slugify(value) : `${slugify(value)}-r${region}`);
      const watch = { id, type, value, label: value, region, addedAt: new Date().toISOString() };
      writeJson(watchlistPath(pid), [...watches, watch]);
      return watch;
    },
    removeWatch(pid, wid) {
      const watches = getWatchlist(pid);
      writeJson(watchlistPath(pid), watches.filter(({ id }) => id !== wid));
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
      const previousFile = getAds(watch.id);
      const ads = Object.assign(Object.create(null), previousFile?.ads);
      const newIds = [];
      for (const raw of rawAds) {
        const previous = ads[raw.creativeId];
        if (!previous) newIds.push(raw.creativeId);
        ads[raw.creativeId] = {
          ...raw,
          lastShown: raw.lastShown ?? previous?.lastShown ?? null,
          imageUrl: raw.imageUrl ?? previous?.imageUrl ?? null,
          image: previous?.image ?? null,
          firstSeenByUs: previous?.firstSeenByUs ?? lastScanAt,
        };
      }
      const savedLabel = previousFile?.watch.label;
      const advertiserName = savedLabel && savedLabel !== watch.value
        ? savedLabel : rawAds[0]?.advertiserName?.trim();
      const label = watch.type === 'advertiser' && watch.label === watch.value && advertiserName
        ? advertiserName : watch.label;
      const file = { watch: { ...watch, label }, lastScanAt, ads: { ...ads } };
      writeJson(adsPath(watch.id), file);
      if (watch.type === 'advertiser' && label !== watch.value) {
        for (const { id } of listProfiles()) {
          const watches = getWatchlist(id);
          const match = watches.find((entry) => entry.id === watch.id && entry.type === watch.type
            && entry.value === watch.value && entry.label === entry.value);
          if (!match) continue;
          match.label = label;
          writeJson(watchlistPath(id), watches);
        }
      }
      return { file, newIds };
    },
    setAdImage(wid, cr, relPath) {
      const file = getAds(wid);
      if (!file || !Object.hasOwn(file.ads, cr)) return;
      file.ads[cr].image = relPath;
      writeJson(adsPath(wid), file);
    },
    appendScanLog(entry) {
      writeJson(logPath, [...getScanLog(), entry].slice(-30));
    },
    getScanLog,
    listAdsForProfile(pid, { filter = 'all', q = '', format = '' } = {}, now = new Date()) {
      const currentTime = new Date(now).getTime();
      const query = q.trim().toLowerCase();
      const creatives = new Map();
      for (const watch of getWatchlist(pid)) {
        const file = getAds(watch.id);
        if (!file) continue;
        const runningSince = Date.parse(file.lastScanAt) - 2 * DAY;
        for (const ad of Object.values(file.ads)) {
          const existing = creatives.get(ad.creativeId);
          const watchIds = existing?.watchIds ?? [];
          const watchLabels = existing?.watchLabels ?? [];
          watchIds.push(watch.id);
          if (!watchLabels.includes(watch.label)) watchLabels.push(watch.label);
          const seen = Date.parse(ad.firstSeenByUs);
          if (existing && seen >= Date.parse(existing.firstSeenByUs)) continue;
          creatives.set(ad.creativeId, {
            ...ad,
            watchId: watch.id,
            watchLabel: watch.label,
            watchIds,
            watchLabels,
            isNew: seen >= currentTime - DAY && seen <= currentTime,
            isRunning: Date.parse(ad.lastShown) >= runningSince,
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
      }).sort((a, b) => Date.parse(b.firstSeenByUs) - Date.parse(a.firstSeenByUs));
    },
    imagesDir() {
      const directory = resolve(data, 'images');
      mkdirSync(directory, { recursive: true });
      return directory;
    },
  };
}
