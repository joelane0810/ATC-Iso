import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScanLocked, ScanBusyError } from '../src/lock.js';
import { startServer } from '../src/server.js';
import { backfillDomains } from '../src/domain-backfill.js';
import { createStore } from '../src/store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scanScript = fileURLToPath(new URL('./scan.js', import.meta.url));

function triggerScan(acquired, watchId) {
  return new Promise((resolve, reject) => {
    const child = fork(scanScript, watchId ? [`--watch=${watchId}`] : [], { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    let busy = false;
    child.once('message', state => {
      if (state === 'acquired') acquired();
      if (state === 'busy') {
        busy = true;
        reject(new ScanBusyError());
      }
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else if (!busy) reject(new Error('Tiến trình quét kết thúc bất thường.'));
    });
  });
}

import { networkInterfaces } from 'node:os';
const host = process.env.ATC_HOST || '0.0.0.0';
const store = createStore(root);
const server = await startServer({
  host,
  store,
  triggerScan,
  waitForAcquisition: true,
  isScanning: () => isScanLocked(join(root, 'data', '.scan.lock')),
  lanUrls: () => host === '0.0.0.0' ? Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => `http://${a.address}:${server.address().port}`) : [],
});
const lan = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
console.log(`Mở http://127.0.0.1:${server.address().port}` + (host === '0.0.0.0' ? ` · máy cùng wifi: ${lan.map((ip) => `http://${ip}:${server.address().port}`).join(' ')}` : ''));
setImmediate(() => {
  void backfillDomains({ store }).catch(error => console.error(`Đọc bù tên miền: ${error.message}`));
});
