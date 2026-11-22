import { regionIdToIso } from './atc.js';
import { scanResumeAt } from './scan-rest.js';

const DAY = 86_400_000;
const OFFSET = 7 * 3_600_000;
const windows = new Map([['day', 1], ['7d', 7], ['30d', 30]]);
const statuses = ['new', 'increase', 'decrease', 'stopped', 'steady'];
const totalKeys = { increase: 'increased', decrease: 'decreased', stopped: 'stopped' };

function datesAt(now) {
  const local = new Date(+new Date(now) + OFFSET);
  const ref = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
    - (local.getUTCHours() < 20 ? DAY : 0);
  return offset => new Date(ref + offset * DAY).toISOString().slice(0, 10);
}

const members = `
  SELECT p.watch_id AS watchId, wc.creative_id AS creativeId, wc.observation, c.image,
    p.label, p.kind,
    CASE WHEN p.kind = 'project' THEN coalesce(json_extract(wc.observation, '$.advertiserId'), '')
      ELSE domain_key(json_extract(wc.observation, '$.domain')) END AS key,
    date(json_extract(wc.observation, '$.firstShown'), '+7 hours') AS firstDay,
    date(wc.last_shown, '+7 hours') AS lastDay,
    json_extract(wc.observation, '$.firstShown') AS firstShown,
    coalesce(nullif(json_extract(wc.observation, '$.advertiserName'), ''), a.name) AS advertiserName
  FROM profile_watches p JOIN watch_creatives wc ON wc.watch_id = p.watch_id
  JOIN creatives c ON c.id = wc.creative_id LEFT JOIN advertisers a ON a.id = c.advertiser_id
  WHERE p.profile_id = ? AND wc.platform = 'search'
`;

function sparkRows(all, pid, start, refDate) {
  return all(`WITH RECURSIVE calendar(day) AS (
      SELECT ? UNION ALL SELECT date(day, '+1 day') FROM calendar WHERE day < ?
    ), members AS (${members}), selected AS MATERIALIZED (
      SELECT watchId, max(firstDay, ?) AS startDay, date(lastDay, '+1 day') AS endDay
      FROM members WHERE firstDay <= ? AND lastDay >= ? AND firstDay <= lastDay
    ), events AS (
      SELECT watchId, startDay AS day, 1 AS delta FROM selected
      UNION ALL SELECT watchId, endDay, -1 FROM selected
    ), changes AS (
      SELECT watchId, day, sum(delta) AS delta FROM events GROUP BY watchId, day
    )
    SELECT watchId, calendar.day AS date,
      sum(coalesce(delta, 0)) OVER (PARTITION BY watchId ORDER BY calendar.day) AS running
    FROM (SELECT DISTINCT watchId FROM changes) CROSS JOIN calendar
    LEFT JOIN changes USING(watchId, day)`, start, refDate, pid, start, refDate, start);
}

export function createTimeReport({ all, scanHistory }) {
  return {
    getSeries(pid, { watchId = null, group = null, days = 90, now = new Date() } = {}) {
      if (!Number.isSafeInteger(days) || days < 1) throw new Error('Số ngày không hợp lệ.');
      const date = datesAt(now);
      // A creative shared by multiple watches counts once on each day.
      const rows = all(`WITH RECURSIVE members AS (${members}), selected AS MATERIALIZED (
          SELECT DISTINCT creativeId, firstDay, lastDay FROM members
          WHERE (? IS NULL OR watchId = ?) AND (? IS NULL OR key = ?) AND firstDay <= ?
        ), calendar(day) AS (
          SELECT ? UNION ALL SELECT date(day, '+1 day') FROM calendar WHERE day < ?
        ), running AS (
          SELECT day, count(DISTINCT creativeId) AS count FROM calendar JOIN selected
            ON firstDay <= day AND lastDay >= day GROUP BY day
        ), starts AS (
          SELECT min(firstDay) AS firstDay FROM selected GROUP BY creativeId
        ), fresh AS (SELECT firstDay, count(*) AS count FROM starts GROUP BY firstDay)
        SELECT day AS date, coalesce(running.count, 0) AS running, coalesce(fresh.count, 0) AS newAds
        FROM calendar LEFT JOIN running USING(day) LEFT JOIN fresh ON firstDay = day ORDER BY day`,
      pid, watchId, watchId, group, group, date(0), date(1 - days), date(0));
      return { refDate: date(0), points: rows.map(row => ({ ...row })) };
    },
    getSummary(pid, { window = 'day', now = new Date() } = {}) {
      const span = windows.get(window);
      if (!span) throw new Error('Khoảng thời gian không hợp lệ.');
      const date = datesAt(now);
      const refDate = date(0);
      const prevDate = date(-span);
      const start = date(1 - span);
      const totals = { newProjects: 0, newAdvertisers: 0, newAds: 0,
        increased: 0, decreased: 0, stopped: 0, runningAds: 0 };
      const watches = all(`SELECT w.id AS watchId, p.label, p.kind, w.last_scan_at AS lastScanAt
        FROM profile_watches p JOIN watches w ON w.id = p.watch_id
        WHERE p.profile_id = ? ORDER BY p.rowid`, pid).map(row => ({
        ...row, groupType: row.kind === 'project' ? 'advertiser' : 'domain',
        runningNow: 0, runningPrev: 0, delta: 0, newAds: 0, newGroups: 0, spark: [], groups: [],
      }));
      const byWatch = new Map(watches.map(watch => [watch.watchId, watch]));
      const byGroup = new Map(watches.map(watch => [watch.watchId, new Map()]));
      const followed = new Set(all(`SELECT w.type, w.value FROM profile_watches p
        JOIN watches w ON w.id = p.watch_id WHERE p.profile_id = ?`, pid)
        .map(({ type, value }) => JSON.stringify([type, value])));
      const spark = new Map(watches.map(watch => [watch.watchId, new Map()]));
      for (const row of sparkRows(all, pid, date(-29), refDate)) {
        spark.get(row.watchId).set(row.date, row.running);
      }
      for (const watch of watches) {
        watch.spark = Array.from({ length: 30 }, (_, index) => {
          const day = date(index - 29);
          return { date: day, running: spark.get(watch.watchId).get(day) ?? 0 };
        });
      }
      const rows = all(`WITH members AS (${members})
        SELECT watchId, key, max(advertiserName) AS advertiserName, count(*) AS totalAds,
          min(firstDay) AS firstDay, min(firstShown) AS firstShown,
          count(*) FILTER (WHERE firstDay <= ? AND lastDay >= ?) AS runningNow,
          count(*) FILTER (WHERE firstDay <= ? AND lastDay >= ?) AS runningPrev,
          count(*) FILTER (WHERE firstDay BETWEEN ? AND ?) AS newAds
        FROM members WHERE firstDay <= ? OR firstDay IS NULL GROUP BY watchId, key`,
      pid, refDate, refDate, prevDate, prevDate, start, refDate, refDate);
      for (const { watchId, key, advertiserName, totalAds, firstDay, firstShown, runningNow, runningPrev, newAds } of rows) {
        const watch = byWatch.get(watchId);
        const { groupType } = watch;
        const delta = runningNow - runningPrev;
        let status = 'steady';
        if (firstDay >= start) status = 'new';
        else if (runningPrev > 0 && runningNow === 0) status = 'stopped';
        else if (delta > 0) status = 'increase';
        else if (delta < 0) status = 'decrease';
        const name = groupType === 'advertiser'
          ? advertiserName || key || 'Chưa rõ nhà quảng cáo' : key || 'Chưa rõ tên miền';
        const group = { key, name, groupType, status, runningNow, runningPrev, delta, newAds, totalAds, firstShown,
          regions: [], sampleAds: [], followed: followed.has(JSON.stringify([groupType, key])) };
        watch.groups.push(group);
        byGroup.get(watchId).set(key, group);
        watch.runningNow += runningNow;
        watch.runningPrev += runningPrev;
        watch.delta += delta;
        watch.newAds += newAds;
        if (status === 'new') {
          watch.newGroups++;
          totals[watch.kind === 'project' ? 'newAdvertisers' : 'newProjects']++;
        }
        if (totalKeys[status]) totals[totalKeys[status]]++;
        totals.newAds += newAds;
        totals.runningAds += runningNow;
      }
      for (const { watchId, key, regionId, running } of all(`WITH members AS (${members})
        SELECT watchId, key, region_id AS regionId, count(*) AS running
        FROM members JOIN creative_regions r ON r.creative_id = members.creativeId
        WHERE firstDay <= ? AND lastDay >= ?
          AND coalesce(substr(r.first_shown, 1, 10), firstDay) <= ? AND substr(r.last_shown, 1, 10) >= ?
        GROUP BY watchId, key, region_id ORDER BY running DESC, regionId`,
      pid, refDate, refDate, refDate, refDate)) {
        byGroup.get(watchId).get(key).regions.push({ regionId, iso: regionIdToIso(regionId), running });
      }
      const samples = all(`WITH members AS (${members}), ranked AS (
          SELECT *, row_number() OVER (PARTITION BY watchId, key ORDER BY
            (firstDay <= ? AND lastDay >= ?) DESC, firstShown DESC, creativeId) AS rank
          FROM members WHERE firstDay <= ? OR firstDay IS NULL
        )
        SELECT watchId, key, observation, image, label, kind,
          (SELECT json_group_array(json_object('regionId', region_id, 'lastShown', last_shown))
            FROM creative_regions WHERE creative_id = ranked.creativeId) AS regions
        FROM ranked WHERE rank <= 4 ORDER BY rank`, pid, refDate, refDate, refDate);
      for (const { watchId, key, observation, image, label, kind, regions } of samples) {
        const ad = JSON.parse(observation);
        byGroup.get(watchId).get(key).sampleAds.push({ ...ad, image: image ?? ad.image ?? null,
          watchId, watchLabel: label, watchKind: kind,
          regions: JSON.parse(regions).map(region => ({ ...region, iso: regionIdToIso(region.regionId) })) });
      }
      for (const watch of watches) {
        watch.groups.sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status)
          || Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));
      }

      const history = scanHistory(new Date(now).toISOString());
      const latest = history.at(-1);
      const resumeAt = scanResumeAt(history, +new Date(now));
      const lastScan = latest ? { at: latest.at, status: latest.status, ...(resumeAt ? { resumeAt } : {}) } : null;
      return { refDate, prevDate, window, dataNote: 'Ngày tham chiếu đổi lúc 20:00 theo giờ Việt Nam.',
        lastScan, totals, watches };
    },
  };
}
