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
      const ads = Object.assign(Object.create(null), getAds(watch.id)?.ads);
      const newIds = [];
      for (const { imageUrl, ...raw } of rawAds) {
        const previous = ads[raw.creativeId];
        if (!previous) newIds.push(raw.creativeId);
        ads[raw.creativeId] = {
          ...raw,
          lastShown: raw.lastShown ?? previous?.lastShown ?? null,
          image: previous?.image ?? null,
          firstSeenByUs: previous?.firstSeenByUs ?? lastScanAt,
        };
      }
      const file = { watch, lastScanAt, ads: { ...ads } };
      writeJson(adsPath(watch.id), file);
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
      const result = [];
      for (const watch of getWatchlist(pid)) {
        const file = getAds(watch.id);
        if (!file) continue;
        const runningSince = Date.parse(file.lastScanAt) - 2 * DAY;
        for (const ad of Object.values(file.ads)) {
          const seen = Date.parse(ad.firstSeenByUs);
          const running = Date.parse(ad.lastShown) >= runningSince;
          if (filter === 'new' && (seen < currentTime - DAY || seen > currentTime)) continue;
          if (filter === 'running' && !running) continue;
          if (filter === 'stopped' && running) continue;
          if (format && ad.format !== format) continue;
          if (query && ![ad.domain, ad.advertiserName, watch.label].some(
            (value) => value?.toLowerCase().includes(query),
          )) continue;
          result.push({ ...ad, watchId: watch.id, watchLabel: watch.label });
        }
      }
      return result.sort((a, b) => Date.parse(b.firstSeenByUs) - Date.parse(a.firstSeenByUs));
    },
    imagesDir() {
      const directory = resolve(data, 'images');
      mkdirSync(directory, { recursive: true });
      return directory;
    },
  };
}
