import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BlockedError } from '../src/atc.js';
import { openChromeClient } from '../src/browser.js';
import { ScanBusyError, withLock } from '../src/lock.js';
import { runScan } from '../src/scanner.js';
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

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function scanOnce({
  root = projectRoot, store = createStore(root), open = openChromeClient,
  sync = syncData, log = console.error, onAcquired = () => {},
} = {}) {
  return withLock(join(root, 'data', '.scan.lock'), async () => {
    onAcquired();
    // Bị Google chặn thì nghỉ 6 tiếng rồi mới quét lại.
    // Trong lúc nghỉ, chỉ quét nhẹ (2 trang, không mở trang chi tiết) các mục mới thêm chưa quét lần nào.
    const COOLDOWN_MS = 6 * 60 * 60 * 1000;
    const history = (await store.getScanLog?.()) ?? [];
    const lastBlockedIndex = history.map(e => e.status).lastIndexOf('blocked');
    const lastBlocked = lastBlockedIndex >= 0 ? history[lastBlockedIndex] : null;
    const okSince = lastBlockedIndex >= 0 && history.slice(lastBlockedIndex + 1).some(e => e.status === 'ok' && !e.light);
    let scanOptions = {};
    if (lastBlocked && !okSince && Date.now() - Date.parse(lastBlocked.at) < COOLDOWN_MS) {
      const resumeAt = new Date(Date.parse(lastBlocked.at) + COOLDOWN_MS).toISOString();
      const fresh = [];
      for (const watch of await store.allWatches()) if (!(await store.getAds(watch.id))) fresh.push(watch.id);
      if (!fresh.length) {
        log('Đang nghỉ sau khi bị Google chặn — chưa quét lại.');
        await store.appendScanLog({ at: new Date().toISOString(), status: 'cooldown', resumeAt, watched: 0, newAds: 0 });
        return { status: 'cooldown', resumeAt };
      }
      scanOptions = { onlyWatchIds: fresh, maxPages: 2, maxDetails: 0 };
    }
    let client;
    let entry;
    let scanId;
    try {
      let showWindow = false;
      try { showWindow = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))?.showBrowser === true; } catch {}
      client = await open({ profileDir: join(root, 'chrome-profile'), headless: !showWindow, debugDir: join(root, 'logs') });
    } catch (error) {
      log(error);
      entry = {
        at: new Date().toISOString(), watched: 0, newAds: 0,
        status: error instanceof BlockedError ? 'blocked' : 'error',
        error: error instanceof BlockedError ? 'Google đã chặn lượt quét' : 'Không mở được trình duyệt.',
      };
      scanId = await store.appendScanLog(entry);
    }
    if (client) {
      try {
        await runScan({ store, client, log, ...scanOptions, record: async value => {
          entry = value;
          scanId = await store.appendScanLog(scanOptions.onlyWatchIds ? { ...value, light: true } : value);
          return scanId;
        } });
      } finally {
        try {
          await client.close();
        } catch (error) {
          log(error);
        }
      }
    }
    const checkpointed = await store.checkpoint();
    const syncResult = checkpointed ? await sync(root)
      : { pushed: false, reason: 'Dữ liệu đang được sử dụng.' };
    await store.setScanSync(scanId, syncResult);
    return entry.status;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const notify = (state) => {
    if (process.connected) process.send(state);
  };
  try {
    const status = await scanOnce({ onAcquired: () => notify('acquired') });
    if (status !== 'ok') process.exitCode = 1;
  } catch (error) {
    if (error instanceof ScanBusyError) notify('busy');
    console.error(error.message);
    process.exitCode = 1;
  }
}
