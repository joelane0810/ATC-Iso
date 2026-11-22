import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Node 22 can emit this warning when the built-in module is loaded.
const emitWarning = process.emitWarning;
let DatabaseSync;
try {
  process.emitWarning = function (warning, ...args) {
    if (warning === 'SQLite is an experimental feature and might change at any time'
        && args[0] === 'ExperimentalWarning') return;
    return emitWarning.call(this, warning, ...args);
  };
  ({ DatabaseSync } = await import('node:sqlite'));
} finally {
  process.emitWarning = emitWarning;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function jsonFiles(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function openDb(data) {
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, 'atc.db'));
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const transaction = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  function ensureWatch(watch) {
    run(`INSERT INTO watches (id, type, value, label, region, kind, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    watch.id, watch.type, watch.value, watch.label, watch.region ?? null,
    watch.kind ?? 'competitor', watch.addedAt ?? null);
  }

  function linkWatch(pid, watch) {
    ensureWatch(watch);
    run(`INSERT INTO profile_watches (profile_id, watch_id, label, kind, added_at)
      VALUES (?, ?, ?, ?, ?)`, pid, watch.id, watch.label,
    watch.kind ?? 'competitor', watch.addedAt ?? null);
  }

  function saveAd(wid, ad) {
    const { creativeId, advertiserId, advertiserName, domain, format, previewUrl,
      imageUrl, image, firstShown, lastShown, platform, firstSeenByUs, detailsUrl } = ad;
    if (advertiserId) {
      run(`INSERT INTO advertisers VALUES (?, ?) ON CONFLICT(id)
        DO UPDATE SET name = coalesce(excluded.name, advertisers.name)`, advertiserId, advertiserName ?? null);
    }
    if (domain) run('INSERT OR IGNORE INTO domains VALUES (?)', domain);
    run(`INSERT INTO creatives (id, advertiser_id, domain, format, first_shown, last_shown,
      preview_url, image_url, image, platform, first_seen_by_us, details_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        advertiser_id = coalesce(excluded.advertiser_id, creatives.advertiser_id),
        domain = coalesce(excluded.domain, creatives.domain),
        format = coalesce(excluded.format, creatives.format),
        first_shown = coalesce(excluded.first_shown, creatives.first_shown),
        last_shown = coalesce(max(excluded.last_shown, creatives.last_shown), excluded.last_shown, creatives.last_shown),
        preview_url = coalesce(excluded.preview_url, creatives.preview_url),
        image_url = coalesce(excluded.image_url, creatives.image_url),
        image = coalesce(excluded.image, creatives.image),
        platform = coalesce(excluded.platform, creatives.platform),
        first_seen_by_us = coalesce(min(excluded.first_seen_by_us, creatives.first_seen_by_us),
          excluded.first_seen_by_us, creatives.first_seen_by_us),
        details_url = coalesce(excluded.details_url, creatives.details_url)`,
    creativeId, advertiserId || null, domain || null, format ?? null, firstShown ?? null, lastShown ?? null,
    previewUrl ?? null, imageUrl ?? null, image ?? null, platform ?? null, firstSeenByUs ?? null, detailsUrl ?? null);

    // Keep the observation from each watch, including its own first-seen date
    // and dates returned by region-filtered searches.
    run(`INSERT INTO watch_creatives VALUES (?, ?, ?) ON CONFLICT(watch_id, creative_id)
      DO UPDATE SET observation = excluded.observation`, wid, creativeId, JSON.stringify(ad));
  }

  function saveScan(entry) {
    return Number(run('INSERT INTO scans (at, status, error, sync, entry) VALUES (?, ?, ?, ?, ?)',
      entry.at ?? null, entry.status ?? null, entry.error ?? null,
      entry.sync == null ? null : JSON.stringify(entry.sync), JSON.stringify(entry)).lastInsertRowid);
  }

  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
        CREATE TABLE IF NOT EXISTS watches (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, value TEXT NOT NULL, region INTEGER,
          label TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('competitor', 'project')),
          added_at TEXT, last_scan_at TEXT
        );
        CREATE TABLE IF NOT EXISTS profile_watches (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          watch_id TEXT NOT NULL REFERENCES watches(id),
          label TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('competitor', 'project')),
          added_at TEXT, PRIMARY KEY (profile_id, watch_id)
        );
        CREATE INDEX IF NOT EXISTS profile_watches_watch ON profile_watches(watch_id);
        CREATE TABLE IF NOT EXISTS advertisers (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE IF NOT EXISTS domains (name TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS creatives (
          id TEXT PRIMARY KEY, advertiser_id TEXT REFERENCES advertisers(id),
          domain TEXT REFERENCES domains(name), format TEXT, first_shown TEXT, last_shown TEXT,
          preview_url TEXT, image_url TEXT, image TEXT, platform TEXT, first_seen_by_us TEXT,
          details_url TEXT, regions_checked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS creatives_regions_pending ON creatives(first_seen_by_us DESC)
          WHERE platform = 'search' AND regions_checked_at IS NULL;
        CREATE TABLE IF NOT EXISTS watch_creatives (
          watch_id TEXT NOT NULL REFERENCES watches(id),
          creative_id TEXT NOT NULL REFERENCES creatives(id), observation TEXT NOT NULL,
          PRIMARY KEY (watch_id, creative_id)
        );
        CREATE INDEX IF NOT EXISTS watch_creatives_creative ON watch_creatives(creative_id);
        CREATE TABLE IF NOT EXISTS creative_regions (
          creative_id TEXT NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
          region_id INTEGER NOT NULL, last_shown TEXT NOT NULL, first_shown TEXT,
          PRIMARY KEY (creative_id, region_id)
        );
        CREATE TABLE IF NOT EXISTS scans (
          id INTEGER PRIMARY KEY, at TEXT, status TEXT, error TEXT, sync TEXT, entry TEXT NOT NULL,
          has_snapshots INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS group_snapshots (
          scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
          watch_id TEXT NOT NULL REFERENCES watches(id), group_type TEXT NOT NULL, group_key TEXT NOT NULL,
          running INTEGER NOT NULL, total INTEGER NOT NULL,
          PRIMARY KEY (scan_id, watch_id, group_type, group_key)
        );
        CREATE INDEX IF NOT EXISTS group_snapshots_history
          ON group_snapshots(watch_id, group_type, group_key, scan_id);
      `);
      if (get('PRAGMA user_version').user_version >= 1) return;
      for (const profile of readJson(join(data, 'profiles.json'), [])) {
        run('INSERT INTO profiles VALUES (?, ?, ?)', profile.id, profile.name, profile.createdAt ?? null);
        for (const watch of readJson(join(data, 'profiles', profile.id, 'watchlist.json'), [])) {
          linkWatch(profile.id, watch);
        }
      }
      const adsDir = join(data, 'ads');
      for (const name of jsonFiles(adsDir)) {
        const { watch, lastScanAt, ads } = readJson(join(adsDir, name), {});
        ensureWatch(watch);
        run('UPDATE watches SET last_scan_at = ?, label = ? WHERE id = ?', lastScanAt ?? null, watch.label, watch.id);
        for (const ad of Object.values(ads)) saveAd(watch.id, ad);
      }
      for (const entry of readJson(join(data, 'scan-log.json'), [])) saveScan(entry);
      db.exec('PRAGMA user_version = 1');
    });
  } catch (error) {
    db.close();
    throw error;
  }
  return { run, get, all, transaction, ensureWatch, linkWatch, saveAd, saveScan };
}
