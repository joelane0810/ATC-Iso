import { existsSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BlockedError } from '../src/atc.js';
import { openChromeClient } from '../src/browser.js';
import { ScanBusyError, withLock } from '../src/lock.js';
import { REST_MS, scanResumeAt } from '../src/scan-rest.js';
import { runScan } from '../src/scanner.js';
import { acquireTabBudget, TabLimitError } from '../src/tab-guard.js';
import { createProgressTracker, progressPath } from '../src/scan-progress.js';
import { createStore } from '../src/store.js';
import { syncToGitHub } from '../src/sync.js';

const execFileAsync = promisify(execFile);
const sqliteSidecars = [':(exclude)data/atc.db-wal', ':(exclude)data/atc.db-shm'];

function syncData(root) {
  return syncToGitHub(root, (command, args, options) => {
    const paths = args.at(-2) === '--' && args.at(-1) === 'data' ? [...args, ...sqliteSidecars] : args;
    return execFileAsync(command, paths, options);
  });
}

const regionsWatchId = 'regions';

async function lookupCreativeRegions({ store, client, creativeIds, scannedAt, scanId, tracker, log }) {
  const entry = { at: scannedAt.toISOString(), watched: 0, newAds: 0, scanId, status: 'ok' };
  const progress = (type, fields) => tracker.handle({ type, watchId: regionsWatchId, ...fields });
  try {
    let done = 0;
    progress('regions', { done, total: creativeIds.length });
    for (const creativeId of creativeIds) {
      const advertiserId = await store.getCreativeAdvertiserId(creativeId);
      if (!advertiserId) throw new Error('Không tìm thấy nhà quảng cáo của mẫu này.');
      const regions = await client.lookupRegions({ advertiserId, creativeId });
      await store.setCreativeRegions(creativeId, regions, scannedAt);
      progress('regions', { done: ++done, total: creativeIds.length });
    }
    progress('done');
  } catch (error) {
    log(error);
    const blocked = error instanceof BlockedError;
    progress('error', { blocked });
    entry.status = blocked ? 'blocked' : 'error';
    entry.error = blocked ? 'Google đã chặn lượt quét' : 'Không lấy được quốc gia.';
  }
  return entry;
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function scanOnce({
  root = projectRoot, store = createStore(root), open = openChromeClient,
  sync = syncData, log = console.error, onAcquired = () => {}, watchId = null, creativeIds = null, probe = false,
  manual = false,
  tabBudget = () => acquireTabBudget({ log }),
} = {}) {
  return withLock(join(root, 'data', '.scan.lock'), async () => {
    if (!creativeIds) await store.purgeExpiredTrash?.();
    const history = (await store.getScanLog?.()) ?? [];
    // Người dùng tự bấm quét thì quét luôn (đầy đủ); thời gian nghỉ chỉ áp cho lượt tự động.
    const resumeAt = manual ? null : scanResumeAt(history);
    if (creativeIds && resumeAt) {
      throw Object.assign(new Error('Đang tạm nghỉ sau khi Google chặn.'), {
        code: 'SCAN_COOLDOWN', resumeAt,
      });
    }
    const watches = creativeIds ? [] : await store.allWatches();
    if (watchId && !watches.some(watch => watch.id === watchId)) throw new Error('Không tìm thấy mục theo dõi.');
    const scanOptions = { onlyWatchIds: watchId ? [watchId] : null, maxDetails: watchId ? 20 : 80 };
    // Kiểm tra Google đã bỏ chặn chưa: chỉ 1 lần hỏi (1 trang của 1 mục), không ảnh, không quốc gia.
    if (probe) {
      if (resumeAt || !watches.length) {
        onAcquired();
        return { status: 'cooldown', resumeAt };
      }
      Object.assign(scanOptions, { onlyWatchIds: [watches[0].id], maxPages: 1, maxDetails: 0, skipCaptures: true });
    }
    if (resumeAt) {
      const eligible = [];
      if (watchId) eligible.push(watchId);
      else for (const watch of watches) if (!(await store.getAds(watch.id))) eligible.push(watch.id);
      if (!eligible.length) {
        onAcquired();
        log('Đang nghỉ sau khi bị Google chặn — chưa quét lại.');
        await store.appendScanLog({ at: new Date().toISOString(), status: 'cooldown', resumeAt, watched: 0, newAds: 0 });
        return { status: 'cooldown', resumeAt };
      }
      Object.assign(scanOptions, { onlyWatchIds: eligible, maxPages: 2, maxDetails: 0, light: true });
    }
    const scanTarget = creativeIds ? regionsWatchId : watchId;
    const withRest = value => ({
      ...value,
      ...(scanTarget ? { watchId: scanTarget } : {}),
      ...(scanOptions.light ? { light: true } : {}),
      ...(probe ? { probe: true } : {}),
      ...(value.status === 'blocked'
        ? { resumeAt: new Date(Date.parse(value.at) + REST_MS).toISOString() }
        : resumeAt ? { resumeAt } : {}),
    });
    let client;
    let entry;
    const scannedAt = new Date();
    let scanId = await store.beginScan?.(scannedAt.toISOString(), scanTarget);
    const tracker = createProgressTracker({ file: progressPath(root) });
    if (creativeIds) tracker.handle({ type: 'start', watchIds: [regionsWatchId] });
    onAcquired();
    try {
      let showWindow = false;
      try { showWindow = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))?.showBrowser === true; } catch {}
      // Trước khi quét: đếm tab ATC đang mở trên máy; cả máy tối đa 2 tab ATC cùng lúc.
      const maxTabs = await tabBudget();
      client = await open({ profileDir: join(root, 'chrome-profile'), headless: !showWindow, debugDir: creativeIds ? undefined : join(root, 'logs'), maxTabs });
    } catch (error) {
      log(error);
      entry = {
        at: scannedAt.toISOString(), watched: 0, newAds: 0, scanId,
        status: error instanceof BlockedError ? 'blocked' : 'error',
        error: error instanceof BlockedError ? 'Google đã chặn lượt quét'
          : error instanceof TabLimitError ? error.message : 'Không mở được trình duyệt.',
      };
      scanId = await store.appendScanLog(withRest(entry));
      if (creativeIds) {
        tracker.handle({ type: 'error', watchId: regionsWatchId, blocked: entry.status === 'blocked' });
        tracker.finish();
      }
    }
    if (client) {
      try {
        if (creativeIds) {
          entry = await lookupCreativeRegions({ store, client, creativeIds, scannedAt, scanId, tracker, log });
          scanId = await store.appendScanLog(withRest(entry));
        } else await runScan({
          store, client, log, ...scanOptions, skipCaptures: Boolean(scanOptions.skipCaptures || (watchId && scanOptions.light)),
          scanId, now: () => scannedAt, progress: event => tracker.handle(event),
          record: async value => {
            entry = value;
            scanId = await store.appendScanLog(withRest(value));
          },
        });
      } finally {
        tracker.finish();
        try {
          await client.close();
        } catch (error) {
          log(error);
        }
      }
    }
    if (creativeIds) return entry.status;
    const checkpointed = await store.checkpoint();
    const syncResult = checkpointed ? await sync(root)
      : { pushed: false, reason: 'Dữ liệu đang được sử dụng.' };
    await store.setScanSync(scanId, syncResult);
    return entry.status;
  });
}

export function scanFromArgs(args, options) {
  const watchId = args.find(arg => arg.startsWith('--watch='))?.slice(8) ?? null;
  if (watchId === '') throw new Error('Vui lòng chọn mục theo dõi.');
  const regionsArg = args.find(arg => arg.startsWith('--regions='));
  const ids = regionsArg?.slice('--regions='.length).split(',');
  if (ids && (watchId || ids.length > 10 || ids.some(id => !/^CR\d+$/.test(id)))) {
    throw new Error('Chọn từ một đến mười mẫu quảng cáo hợp lệ.');
  }
  const probe = args.includes('--probe');
  const manual = args.includes('--manual');
  return scanOnce({ ...options, watchId, probe, manual, creativeIds: ids ? [...new Set(ids)] : null });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Tự cập nhật máy chủ: có tệp cờ data/.restart-server và tiến trình này do máy chủ web mở
  // -> tắt máy chủ cũ để launchd bật lại bằng mã mới, rồi dừng (không quét lượt này).
  const restartFlag = join(projectRoot, 'data', '.restart-server');
  if (typeof process.send === 'function' && existsSync(restartFlag)) {
    rmSync(restartFlag, { force: true });
    console.error('Khởi động lại máy chủ web để dùng bản mới.');
    process.kill(process.ppid, 'SIGTERM');
    process.exit(0);
  }
  const notify = (state) => {
    if (process.connected) process.send(state);
  };
  try {
    const status = await scanFromArgs(process.argv.slice(2), { onAcquired: () => notify('acquired') });
    if (status !== 'ok') process.exitCode = 1;
  } catch (error) {
    if (error instanceof ScanBusyError) notify('busy');
    if (error.code === 'SCAN_COOLDOWN') notify({ resumeAt: error.resumeAt });
    console.error(error.message);
    process.exitCode = 1;
  }
}
