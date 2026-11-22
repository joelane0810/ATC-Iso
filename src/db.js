import { domainKey, groupAds, groupTypes, runningAt } from './groups.js';
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

const SCHEMA_VERSION = 2;
const retryWait = new Int32Array(new SharedArrayBuffer(4));

export function isSqliteBusy(error) {
  return error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 255) === 5;
}

export function configureJournal(get, log = console.warn) {
  try {
    get('PRAGMA journal_mode = WAL');
    if (get('PRAGMA journal_mode').journal_mode === 'wal') return;
  } catch (error) {
    if (error.code !== 'ERR_SQLITE_ERROR' || isSqliteBusy(error)) throw error;
  }
  const { journal_mode } = get('PRAGMA journal_mode = DELETE');
  if (journal_mode !== 'delete') throw new Error('Không thể thiết lập chế độ lưu dữ liệu.');
  log('Ổ lưu dữ liệu không hỗ trợ WAL. Đang dùng chế độ DELETE.');
}

export function openDb(data, { readOnly = false, web = false } = {}) {
  if (!readOnly) mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, 'atc.db'), { readOnly });
  db.function('domain_key', { deterministic: true }, domainKey);
  db.function('fold_name', { deterministic: true }, value => value?.trim().normalize('NFC').toLowerCase() ?? '');
  const statements = new Map();
  function prepare(sql) {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  }
  const run = (sql, ...args) => prepare(sql).run(...args);
  const get = (sql, ...args) => prepare(sql).get(...args);
  const all = (sql, ...args) => prepare(sql).all(...args);
  const close = () => db.close();
  function transaction(work, mode = 'IMMEDIATE') {
    for (let attempt = 0; ; attempt++) {
      let started = false;
      try {
        db.exec('BEGIN ' + mode);
        started = true;
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (started) db.exec('ROLLBACK');
        if (web || attempt >= 2 || !isSqliteBusy(error)) throw error;
        Atomics.wait(retryWait, 0, 0, 25 * (attempt + 1));
      }
    }
  }

  function ensureWatch(watch) {
    run(`INSERT INTO watches (id, type, value, label, region, kind, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    watch.id, watch.type, watch.value, watch.label, watch.region ?? null,
    watch.kind ?? 'competitor', watch.addedAt ?? null);
  }

  function linkWatch(pid, watch) {
    ensureWatch(watch);
    run(`INSERT INTO profile_watches (profile_id, watch_id, label, kind, added_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_id, watch_id) DO NOTHING`, pid, watch.id, watch.label,
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
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', ?), ?, ?, ?, ?,
        strftime('%Y-%m-%dT%H:%M:%fZ', ?), ?) ON CONFLICT(id) DO UPDATE SET
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
    run(`INSERT INTO watch_creatives (watch_id, creative_id, observation, first_seen, last_shown, platform)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', ?), strftime('%Y-%m-%dT%H:%M:%fZ', ?), ?)
      ON CONFLICT(watch_id, creative_id) DO UPDATE SET
      observation = excluded.observation, first_seen = excluded.first_seen,
      last_shown = excluded.last_shown, platform = excluded.platform`,
    wid, creativeId, JSON.stringify(ad), ad.firstSeenByUs ?? null, ad.lastShown ?? null, ad.platform ?? null);
  }

  function saveScan(entry) {
    return Number(run('INSERT INTO scans (at, status, error, sync, entry) VALUES (?, ?, ?, ?, ?)',
      entry.at ?? null, entry.status ?? null, entry.error ?? null,
      entry.sync == null ? null : JSON.stringify(entry.sync), JSON.stringify(entry)).lastInsertRowid);
  }

  function saveSnapshot(scanId, wid, at, ads) {
    run('INSERT INTO watch_scans (scan_id, watch_id, at) VALUES (?, ?, ?)', scanId, wid, at);
    for (const type of groupTypes) {
      for (const { key, name, ads: members } of groupAds(ads, type).values()) {
        const running = members.filter(ad => runningAt(ad.lastShown, Date.parse(at))).length;
        run(`INSERT INTO group_snapshots
          (scan_id, watch_id, group_type, group_key, running, total, name)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, scanId, wid, type, key, running, members.length, name);
      }
    }
  }

  function importWatch(watch) {
    const shared = get('SELECT id FROM watches WHERE type = ? AND value = ? AND region IS ?',
      watch.type, watch.value, watch.region ?? null);
    if (shared) return { ...watch, id: shared.id };
    let id = watch.id;
    for (let suffix = 2; get('SELECT 1 FROM watches WHERE id = ?', id); suffix++) id = `${watch.id}-${suffix}`;
    return { ...watch, id };
  }

  try {
    db.exec(`PRAGMA busy_timeout = ${web ? 250 : 750}; PRAGMA foreign_keys = ON;`);
    const version = () => get('PRAGMA user_version').user_version;
    if (version() > SCHEMA_VERSION) throw new Error('Dữ liệu được tạo bởi phiên bản mới hơn.');
    if (version() < SCHEMA_VERSION) {
      if (readOnly) throw new Error('Dữ liệu chưa sẵn sàng.');
      // Journal mode cannot change inside a transaction.
      for (let attempt = 0; version() < SCHEMA_VERSION; attempt++) {
        try {
          configureJournal(get);
          break;
        } catch (error) {
          if (web || attempt >= 2 || !isSqliteBusy(error)) throw error;
          Atomics.wait(retryWait, 0, 0, 25 * (attempt + 1));
        }
      }
      transaction(() => {
        const previous = version();
        if (previous >= SCHEMA_VERSION) return;
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
        db.exec(`
          ALTER TABLE creatives ADD COLUMN regions_retry INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE watch_creatives ADD COLUMN first_seen TEXT;
          ALTER TABLE watch_creatives ADD COLUMN last_shown TEXT;
          ALTER TABLE watch_creatives ADD COLUMN platform TEXT;
          ALTER TABLE group_snapshots ADD COLUMN name TEXT;
          CREATE INDEX watch_creatives_dates ON watch_creatives(watch_id, platform, last_shown, first_seen);
          CREATE INDEX creatives_region_check ON creatives(regions_checked_at);
          CREATE TABLE watch_scans (
            scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
            watch_id TEXT NOT NULL REFERENCES watches(id), at TEXT NOT NULL,
            PRIMARY KEY (watch_id, scan_id)
          );
        `);
        if (previous === 0) {
          for (const profile of readJson(join(data, 'profiles.json'), [])) {
            run('INSERT INTO profiles VALUES (?, ?, ?)', profile.id, profile.name, profile.createdAt ?? null);
            for (const watch of readJson(join(data, 'profiles', profile.id, 'watchlist.json'), [])) {
              linkWatch(profile.id, importWatch(watch));
            }
          }
          const adsDir = join(data, 'ads');
          for (const name of jsonFiles(adsDir)) {
            const { watch: metadata, lastScanAt, ads } = readJson(join(adsDir, name), {});
            const watch = importWatch(metadata);
            ensureWatch(watch);
            run('UPDATE watches SET last_scan_at = ?, label = ? WHERE id = ?', lastScanAt ?? null, watch.label, watch.id);
            for (const ad of Object.values(ads)) saveAd(watch.id, ad);
          }
          for (const entry of readJson(join(data, 'scan-log.json'), [])) saveScan(entry);
        } else {
          db.exec(`UPDATE watch_creatives SET first_seen = strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(observation, '$.firstSeenByUs')),
            last_shown = strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(observation, '$.lastShown')),
            platform = json_extract(observation, '$.platform');
            UPDATE creatives SET first_seen_by_us = strftime('%Y-%m-%dT%H:%M:%fZ', first_seen_by_us),
              last_shown = strftime('%Y-%m-%dT%H:%M:%fZ', last_shown);
            INSERT OR IGNORE INTO watch_scans (scan_id, watch_id, at)
              SELECT s.id, w.id, s.at FROM scans s
              JOIN json_each(s.entry, '$.changes') change
              JOIN watches w ON w.id = json_extract(change.value, '$.watchId')
              WHERE s.has_snapshots = 1 AND s.at IS NOT NULL`);
        }
        for (const { id, last_scan_at: at } of all(`SELECT w.id, w.last_scan_at FROM watches w
          WHERE w.last_scan_at IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM watch_scans ws WHERE ws.watch_id = w.id AND ws.at = w.last_scan_at)`)) {
          const scanId = saveScan({ at });
          const ads = all('SELECT observation FROM watch_creatives WHERE watch_id = ?', id)
            .map(row => JSON.parse(row.observation));
          saveSnapshot(scanId, id, at, ads);
        }
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
  } catch (error) {
    close();
    throw error;
  }
  return { run, get, all, transaction, ensureWatch, linkWatch, saveAd, saveScan, saveSnapshot, close };
}
