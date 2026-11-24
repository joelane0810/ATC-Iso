import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScanLocked, ScanBusyError } from '../src/lock.js';
import { startServer } from '../src/server.js';
import { backfillDomains } from '../src/domain-backfill.js';
import { createStore } from '../src/store.js';
import { createAccess, readAccessConfig } from '../src/access/index.js';
import { createSnapshotBackfill } from '../src/preview-snapshot.js';
import { backfillRegions } from './scan.js';
import { readProgress } from '../src/scan-progress.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scanScript = fileURLToPath(new URL('./scan.js', import.meta.url));

let afterScan = () => {};

function triggerScan(acquired, watchId, creativeIds, { automatic = false, probe = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = creativeIds ? [`--regions=${creativeIds.join(',')}`] : watchId ? [`--watch=${watchId}`] : [];
    if (!automatic && !probe) args.push('--manual');
    if (probe) args.push('--probe');
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
      afterScan(!creativeIds);
      if (code === 0) resolve();
      else if (!busy) reject(new Error('Tiến trình quét kết thúc bất thường.'));
    });
  });
}

const host = process.env.ATC_HOST || '0.0.0.0';
const store = createStore(root);
const access = createAccess(readAccessConfig(root));
const isScanning = () => isScanLocked(join(root, 'data', '.scan.lock'));
const server = await startServer({
  host,
  store,
  triggerScan,
  waitForAcquisition: true,
  isScanning,
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
const backfillSnapshots = createSnapshotBackfill({ store });
const runSnapshots = () => void backfillSnapshots().catch(error => console.error(`Chụp bù ảnh: ${error.message}`));
setImmediate(runSnapshots);
setInterval(runSnapshots, 30 * 60_000).unref();

// Lượt quét theo lịch có thể chạy bên ngoài máy chủ.
const lastScanKey = () => JSON.stringify(store.getScanLog().at(-1));
let completedScan = lastScanKey();
const checkCompletedScan = async () => {
  try {
    const key = lastScanKey();
    if (key === completedScan || await isScanning()) return;
    const latest = lastScanKey();
    if (latest === completedScan) return;
    completedScan = latest;
    runSnapshots();
  } catch (error) {
    console.error(`Kiểm tra lượt quét để chụp bù ảnh: ${error.message}`);
  }
};
setInterval(checkCompletedScan, 15_000).unref();
afterScan = fullScan => {
  if (fullScan) runBackfill();
  checkCompletedScan();
};

setInterval(() => {
  void backfillRegions({ store, isScanning, triggerScan }).catch(error => {
    if (!['SCAN_BUSY', 'SCAN_COOLDOWN'].includes(error.code)) console.error(`Lấy bù quốc gia: ${error.message}`);
  });
}, 15 * 60_000).unref();

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { access.stop(); process.exit(0); });

// Tự kiểm tra Google đã bỏ chặn chưa: hết thời gian nghỉ mà lượt gần nhất vẫn là "bị chặn"
// thì gửi đúng 1 lần hỏi nhẹ. Qua → quét lại bình thường; còn chặn → nghỉ tiếp 6 tiếng.
const probeTimer = setInterval(async () => {
  try {
    if (await isScanning()) return;
    const log = (await store.getScanLog?.()) ?? [];
    // Lượt chặn gần nhất mà sau đó chưa có lượt quét đầy đủ nào qua được (bỏ qua lượt nhẹ/nghỉ).
    const last = [...log].reverse().find(entry => entry.status === 'blocked' || (entry.status === 'ok' && !entry.light));
    if (last?.status !== 'blocked') return;
    const resume = last.resumeAt ? Date.parse(last.resumeAt) : Date.parse(last.at) + 6 * 3600_000;
    if (Date.now() < resume) return;
    console.error('Hết thời gian nghỉ — kiểm tra Google đã bỏ chặn chưa.');
    await triggerScan(() => {}, null, null, { probe: true }).catch(() => {});
  } catch (error) {
    console.error(`Kiểm tra bỏ chặn: ${error.message}`);
  }
}, 10 * 60_000);
probeTimer.unref();
