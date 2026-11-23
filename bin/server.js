import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScanLocked, ScanBusyError } from '../src/lock.js';
import { startServer } from '../src/server.js';
import { backfillDomains } from '../src/domain-backfill.js';
import { createStore } from '../src/store.js';
import { createAccess, readAccessConfig } from '../src/access/index.js';
import { readProgress } from '../src/scan-progress.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scanScript = fileURLToPath(new URL('./scan.js', import.meta.url));

let afterScan = () => {};

function triggerScan(acquired, watchId, creativeIds) {
  return new Promise((resolve, reject) => {
    const args = creativeIds ? [`--regions=${creativeIds.join(',')}`] : watchId ? [`--watch=${watchId}`] : [];
    const child = fork(scanScript, args, { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    let busy = false;
    child.once('message', state => {
      if (state === 'acquired') acquired();
      if (state?.resumeAt) reject(Object.assign(new Error('Đang tạm nghỉ sau khi Google chặn.'), {
        code: 'SCAN_COOLDOWN', resumeAt: state.resumeAt,
      }));
      if (state === 'busy') {
        busy = true;
        reject(new ScanBusyError());
      }
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (!creativeIds) afterScan();
      if (code === 0) resolve();
      else if (!busy) reject(new Error('Tiến trình quét kết thúc bất thường.'));
    });
  });
}

const host = process.env.ATC_HOST || '0.0.0.0';
const store = createStore(root);
const access = createAccess(readAccessConfig(root));
const server = await startServer({
  host,
  store,
  triggerScan,
  waitForAcquisition: true,
  isScanning: () => isScanLocked(join(root, 'data', '.scan.lock')),
  access,
  lanUrls: () => host === '0.0.0.0' ? access.urls(server.address().port) : [],
  accessStatus: () => access.status(),
  readScanProgress: () => readProgress(root),
});
access.start({ root, port: server.address().port, log: message => console.error(message) });
console.log(`Mở http://127.0.0.1:${server.address().port} · máy khác qua ${access.name}: ${access.urls(server.address().port).join(' ')}`);
// Đọc bù tên miền: lúc bật máy chủ, sau mỗi lượt quét và cứ 30 phút một lần.
const runBackfill = () => void backfillDomains({ store }).catch(error => console.error(`Đọc bù tên miền: ${error.message}`));
setImmediate(runBackfill);
setInterval(runBackfill, 30 * 60_000).unref();
afterScan = runBackfill;

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { access.stop(); process.exit(0); });
