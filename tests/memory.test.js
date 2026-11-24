import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, summarizeMemory } from '../src/memory.js';

test('memory groups the server tree by kind', () => {
  const rows = parsePs(`  10     1  102400 /usr/local/bin/node bin/server.js
  11    10  204800 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless
  12    11   51200 Google Chrome Helper (Renderer)
  13    10   30720 data/gateway/atc-iso-gateway -hostname atc-iso
  99     1  999999 /Applications/Other.app`);
  assert.deepEqual(summarizeMemory(rows, 10), { totalMb: 380, groups: { server: 100, chrome: 250, gateway: 30 }, processes: 4 });
});
