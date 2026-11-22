import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { createStore } from '../src/store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scanScript = fileURLToPath(new URL('./scan.js', import.meta.url));
let child;

function triggerScan() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [scanScript], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => {
      child = undefined;
      if (code === 0) resolve();
      else reject(new Error('Tiến trình quét kết thúc bất thường.'));
    });
  });
}

const server = await startServer({
  store: createStore(root),
  triggerScan,
  isScanning: () => Boolean(child),
});
console.log(`Mở http://127.0.0.1:${server.address().port}`);
