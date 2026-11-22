import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireTabBudget, countExternalAtcTabs, isAtcUrl, TabLimitError } from '../src/tab-guard.js';

test('isAtcUrl only matches the ATC host', () => {
  assert.equal(isAtcUrl('https://adstransparency.google.com/?region=anywhere'), true);
  assert.equal(isAtcUrl('https://google.com/search?q=adstransparency.google.com'), false);
  assert.equal(isAtcUrl('chrome://newtab'), false);
});

test('countExternalAtcTabs sums browsers on macOS and is 0 elsewhere', async () => {
  assert.equal(await countExternalAtcTabs({ platform: 'linux', run: async () => 5 }), 0);
  assert.equal(await countExternalAtcTabs({ platform: 'darwin', run: async (script) => script.includes('Brave') ? 1 : 0 }), 1);
});

test('budget is 2 with no other ATC tab, 1 with one', async () => {
  assert.equal(await acquireTabBudget({ count: async () => 0, log: () => {} }), 2);
  assert.equal(await acquireTabBudget({ count: async () => 1, log: () => {} }), 1);
});

test('waits while two tabs are open, proceeds once one closes', async () => {
  const counts = [2, 2, 1];
  const waits = [];
  const budget = await acquireTabBudget({ count: async () => counts.shift(), log: () => {}, wait: async (ms) => waits.push(ms), intervalMs: 10, maxWaitMs: 100 });
  assert.equal(budget, 1);
  assert.equal(waits.length, 2);
});

test('gives up with TabLimitError after max wait', async () => {
  await assert.rejects(
    acquireTabBudget({ count: async () => 3, log: () => {}, wait: async () => {}, intervalMs: 10, maxWaitMs: 30 }),
    TabLimitError,
  );
});
