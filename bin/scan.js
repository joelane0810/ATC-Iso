import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChromeClient } from '../src/browser.js';
import { withLock } from '../src/lock.js';
import { runScan } from '../src/scanner.js';
import { createStore } from '../src/store.js';
import { syncToGitHub } from '../src/sync.js';

const root = fileURLToPath(new URL('../', import.meta.url));

try {
  await withLock(join(root, 'data', '.scan.lock'), async () => {
    const store = createStore(root);
    const client = await openChromeClient({ profileDir: join(root, 'chrome-profile') });
    try {
      const result = await runScan({ store, client });
      await syncToGitHub(root);
      if (result.status !== 'ok') process.exitCode = 1;
    } finally {
      await client.close();
    }
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
