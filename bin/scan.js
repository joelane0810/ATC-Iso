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
    const lastLog = (await store.getScanLog?.())?.at(-1);
    const COOLDOWN_MS = 6 * 60 * 60 * 1000;
    if (lastLog?.status === 'blocked' && Date.now() - Date.parse(lastLog.at) < COOLDOWN_MS) {
      log('Đang nghỉ sau khi bị Google chặn — chưa quét lại.');
      return { status: 'cooldown' };
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
        await runScan({ store, client, log, record: async value => {
          entry = value;
          scanId = await store.appendScanLog(value);
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
