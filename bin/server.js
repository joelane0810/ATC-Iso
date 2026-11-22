import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScanLocked, ScanBusyError } from '../src/lock.js';
import { startServer } from '../src/server.js';
import { createStore } from '../src/store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scanScript = fileURLToPath(new URL('./scan.js', import.meta.url));

function triggerScan(acquired) {
  return new Promise((resolve, reject) => {
    const child = fork(scanScript, { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
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

const server = await startServer({
  store: createStore(root),
  triggerScan,
  waitForAcquisition: true,
  isScanning: () => isScanLocked(join(root, 'data', '.scan.lock')),
});
console.log(`Mở http://127.0.0.1:${server.address().port}`);
