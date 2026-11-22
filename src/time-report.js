import { regionIdToIso } from './atc.js';
import { scanResumeAt } from './scan-rest.js';

const DAY = 86_400_000;
const OFFSET = 7 * 3_600_000;
const windows = new Map([['day', 1], ['7d', 7], ['30d', 30]]);
const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY;
const shiftDate = (date, days) => new Date(Date.parse(date) + days * DAY).toISOString().split('T')[0];

export function vietnamDate(value) {
  const time = value == null ? NaN : Date.parse(value);
  return Number.isFinite(time) ? new Date(time + OFFSET).toISOString().split('T')[0] : null;
}

const statuses = ['new', 'increase', 'decrease', 'stopped', 'steady'];
const totalKeys = { increase: 'increased', decrease: 'decreased', stopped: 'stopped' };

function referenceDate(now) {
  const local = new Date(+new Date(now) + OFFSET);
  const date = local.toISOString().split('T')[0];
  return local.getUTCHours() < 20 ? shiftDate(date, -1) : date;
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
  WHERE p.profile_id = ? AND p.deleted_at IS NULL AND wc.platform = 'search'
`;

// Dữ liệu chỉ mới bằng lần quét gần nhất: ngày tham chiếu không được vượt quá
// ngày mà lần quét đó đã thấy đủ (cùng luật 20:00 giờ Việt Nam).
function effectiveNow(all, pid, watchId, now) {
  const row = all(`SELECT min(w.last_scan_at) AS at FROM profile_watches p JOIN watches w ON w.id = p.watch_id
    WHERE p.profile_id = ? AND p.deleted_at IS NULL AND (? IS NULL OR p.watch_id = ?) AND w.last_scan_at IS NOT NULL`, pid, watchId, watchId)[0];
  const scanned = row?.at ? Date.parse(row.at) : NaN;
  return Number.isFinite(scanned) && scanned < +new Date(now) ? new Date(scanned) : new Date(now);
}

function reportDates(all, pid, watchId, now) {
  const refDate = referenceDate(effectiveNow(all, pid, watchId, now));
  const [{ minDate }] = all(`SELECT min(date(json_extract(wc.observation, '$.firstShown'), '+7 hours')) AS minDate
    FROM profile_watches p JOIN watch_creatives wc ON wc.watch_id = p.watch_id
    WHERE p.profile_id = ? AND p.deleted_at IS NULL AND (? IS NULL OR p.watch_id = ?)`, pid, watchId, watchId);
  return { refDate, minDate: minDate ?? refDate };
}

function resolveRange(from, to, defaultFrom, refDate) {
  for (const value of [from, to]) {
    if (value == null) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
        shiftDate(value, 0) !== value) throw new Error('Ngày không hợp lệ. Vui lòng dùng dạng năm-tháng-ngày.');
  }
  if (from != null && to != null && from > to) throw new Error('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
  from ??= defaultFrom;
  to ??= refDate;
  return { from: from > refDate ? refDate : from, to: to > refDate ? refDate : to };
}

export function adsDateRange(all, pid, watchId, { from, to }, now) {
  const refDate = referenceDate(effectiveNow(all, pid, watchId, now));
  return resolveRange(from, to, '0000-01-01', refDate);
}

function createBuckets(from, to) {
  const length = daysBetween(from, to) + 1;
  const step = length > 120 ? 7 : 1;
  const size = Math.ceil(length / step);
  const changes = new Int32Array(size + 1);
  const starts = new Int32Array(size);
  const index = date => Math.floor(daysBetween(from, date) / step);
  let previousId;
  let coveredThrough = -1;
  return {
    bucket: step === 1 ? 'day' : 'week',
    // Rows for the same creative arrive in order of first display.
    add({ creativeId, firstDay, lastDay }) {
      if (firstDay == null || firstDay > to) return;
      if (creativeId !== previousId) {
        previousId = creativeId;
        coveredThrough = -1;
        if (firstDay >= from) starts[index(firstDay)]++;
      }
      if (lastDay == null || lastDay < from || lastDay < firstDay) return;
      const end = Math.min(size - 1, index(lastDay));
      const start = Math.max(coveredThrough + 1, index(firstDay));
      if (start > end) return;
      changes[start]++;
      changes[end + 1]--;
      coveredThrough = end;
    },
    points(limit = size) {
      let running = 0;
      const points = [];
      for (let i = 0; i < size; i++) {
        running += changes[i];
        if (i >= size - limit) {
          points.push({ date: shiftDate(from, i * step), running, newAds: starts[i] });
        }
      }
      return points;
    },
  };
}

export function createTimeReport({ all, scanHistory }) {
  return {
    getSeries(pid, { watchId = null, group = null, from, to, days, now = new Date() } = {}) {
      const dates = reportDates(all, pid, watchId, now);
      const { refDate, minDate } = dates;
      let defaultFrom = minDate < refDate ? minDate : refDate;
      if (from == null && to == null && days != null) {
        if (!Number.isSafeInteger(days) || days < 1 || days > daysBetween('0000-01-01', refDate) + 1) {
          throw new Error('Số ngày không hợp lệ.');
        }
        defaultFrom = shiftDate(refDate, 1 - days);
      } else if (to != null && to < defaultFrom) {
        defaultFrom = to;
      }
      const range = resolveRange(from, to, defaultFrom, refDate);
      const buckets = createBuckets(range.from, range.to);
      // A creative shared by multiple watches counts once per bucket.
      for (const row of all(`WITH members AS (${members})
        SELECT creativeId, firstDay, lastDay FROM members
        WHERE (? IS NULL OR watchId = ?) AND (? IS NULL OR key = ?) AND firstDay <= ?
        ORDER BY creativeId, firstDay`, pid, watchId, watchId, group, group, range.to)) {
        buckets.add(row);
      }
      return { ...dates, ...range, bucket: buckets.bucket, points: buckets.points() };
    },
    getSummary(pid, { window = 'day', from, to, now = new Date() } = {}) {
      const span = windows.get(window);
      if (!span) throw new Error('Khoảng thời gian không hợp lệ.');
      const dates = reportDates(all, pid, null, now);
      const { refDate } = dates;
      const range = resolveRange(from, to, to ?? shiftDate(refDate, 1 - span), refDate);
      const { from: start, to: end } = range;
      const prevTo = shiftDate(start, -1);
      const prevFrom = shiftDate(prevTo, -daysBetween(start, end));
      const totals = { newProjects: 0, newAdvertisers: 0, newAds: 0,
        increased: 0, decreased: 0, stopped: 0, runningAds: 0,
        increasedAds: 0, decreasedAds: 0, stoppedAds: 0 };
      const watches = all(`SELECT w.id AS watchId, p.label, p.kind, w.last_scan_at AS lastScanAt
        FROM profile_watches p JOIN watches w ON w.id = p.watch_id
        WHERE p.profile_id = ? AND p.deleted_at IS NULL ORDER BY p.rowid`, pid).map(row => ({
        ...row, groupType: row.kind === 'project' ? 'advertiser' : 'domain',
        runningNow: 0, runningPrev: 0, delta: 0, newAds: 0, newGroups: 0, spark: [], groups: [],
      }));
      const byWatch = new Map(watches.map(watch => [watch.watchId, watch]));
      const byGroup = new Map(watches.map(watch => [watch.watchId, new Map()]));
      const followed = new Set(all(`SELECT w.type, w.value FROM profile_watches p
        JOIN watches w ON w.id = p.watch_id WHERE p.profile_id = ? AND p.deleted_at IS NULL`, pid)
        .map(({ type, value }) => JSON.stringify([type, value])));
      const sparks = new Map(watches.map(({ watchId }) => [watchId, createBuckets(start, end)]));
      for (const row of all(`WITH members AS (${members})
        SELECT watchId, creativeId, firstDay, lastDay FROM members
        WHERE firstDay <= ? AND lastDay >= ? AND firstDay <= lastDay ORDER BY creativeId, firstDay`, pid, end, start)) {
        sparks.get(row.watchId).add(row);
      }
      for (const watch of watches) {
        watch.spark = sparks.get(watch.watchId).points(120).map(({ date, running }) => ({ date, running }));
      }
      const rows = all(`WITH members AS (${members})
        SELECT watchId, key, max(advertiserName) AS advertiserName, count(*) AS totalAds,
          min(firstDay) AS firstDay, min(firstShown) AS firstShown,
          count(*) FILTER (WHERE firstDay <= ? AND lastDay >= ? AND firstDay <= lastDay) AS runningNow,
          count(*) FILTER (WHERE firstDay <= ? AND lastDay >= ? AND firstDay <= lastDay) AS runningPrev,
          count(*) FILTER (WHERE firstDay BETWEEN ? AND ?) AS newAds
        FROM members WHERE firstDay <= ? OR firstDay IS NULL GROUP BY watchId, key`,
      pid, end, start, prevTo, prevFrom, start, end, end);
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
        if (status === 'increase') totals.increasedAds += delta;
        if (status === 'decrease') totals.decreasedAds += delta;
        if (status === 'stopped') totals.stoppedAds -= runningPrev;
        totals.newAds += newAds;
        totals.runningAds += runningNow;
      }
      for (const { watchId, key, regionId, running } of all(`WITH members AS (${members})
        SELECT watchId, key, region_id AS regionId, count(*) AS running
        FROM members JOIN creative_regions r ON r.creative_id = members.creativeId
        WHERE firstDay <= ? AND lastDay >= ? AND firstDay <= lastDay
          AND coalesce(substr(r.first_shown, 1, 10), firstDay) <= min(?, lastDay)
          AND substr(r.last_shown, 1, 10) >= max(?, firstDay)
        GROUP BY watchId, key, region_id ORDER BY running DESC, regionId`,
      pid, end, start, end, start)) {
        byGroup.get(watchId).get(key).regions.push({ regionId, iso: regionIdToIso(regionId), running });
      }
      const samples = all(`WITH members AS (${members}), ranked AS (
          SELECT *, row_number() OVER (PARTITION BY watchId, key ORDER BY
            (firstDay <= ? AND lastDay >= ? AND firstDay <= lastDay) DESC, firstShown DESC, creativeId) AS rank
          FROM members WHERE firstDay <= ? OR firstDay IS NULL
        )
        SELECT watchId, key, observation, image, label, kind,
          (SELECT json_group_array(json_object('regionId', region_id, 'lastShown', last_shown))
            FROM creative_regions WHERE creative_id = ranked.creativeId) AS regions
        FROM ranked WHERE rank <= 4 ORDER BY rank`, pid, end, start, end);
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
      return { ...dates, ...range, prevFrom, prevTo, prevDate: prevTo, window, dataNote: `Dữ liệu đến hết ngày ${refDate.slice(8, 10)}/${refDate.slice(5, 7)} — ATC cập nhật quảng cáo của ngày hôm nay sau khoảng 20:00 (giờ Việt Nam).`,
        lastScan, totals, watches };
    },
  };
}
