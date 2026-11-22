import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlockedError } from '../src/atc.js';
import { openChromeClient } from '../src/browser.js';
import { ScanBusyError, withLock } from '../src/lock.js';
import { runScan } from '../src/scanner.js';
import { createStore } from '../src/store.js';
import { syncToGitHub } from '../src/sync.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function scanOnce({
  root = projectRoot, store = createStore(root), open = openChromeClient,
  sync = syncToGitHub, log = console.error, onAcquired = () => {},
} = {}) {
  return withLock(join(root, 'data', '.scan.lock'), async () => {
    onAcquired();
    let client;
    let entry;
    try {
      let showWindow = false;
      try { showWindow = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))?.showBrowser === true; } catch {}
      client = await open({ profileDir: join(root, 'chrome-profile'), headless: !showWindow });
    } catch (error) {
      log(error);
      entry = {
        at: new Date().toISOString(), watched: 0, newAds: 0,
        status: error instanceof BlockedError ? 'blocked' : 'error',
        error: error instanceof BlockedError ? 'Google đã chặn lượt quét' : 'Không mở được trình duyệt.',
      };
    }
    if (client) {
      try {
        await runScan({ store, client, log, record: value => { entry = value; } });
      } finally {
        try {
          await client.close();
        } catch (error) {
          log(error);
        }
      }
    }
    const syncResult = await sync(root);
    await store.appendScanLog({ ...entry, sync: syncResult });
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
