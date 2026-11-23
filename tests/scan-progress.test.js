import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProgressTracker } from '../src/scan-progress.js';

test('progress tracker follows each watch from queued to done and marks the rest skipped on a block', () => {
  const writes = [];
  const tracker = createProgressTracker({ file: 'x', write: (_, state) => writes.push(JSON.parse(JSON.stringify(state))), now: () => new Date('2026-11-23T02:00:00Z') });
  tracker.handle({ type: 'start', watchIds: ['a', 'b', 'c'] });
  assert.deepEqual(Object.values(tracker.state.watches).map(w => w.state), ['queued', 'queued', 'queued']);
  tracker.handle({ type: 'page', watchId: 'a', page: 2, maxPages: 5, ads: 80 });
  assert.equal(tracker.state.watches.a.state, 'scanning');
  assert.equal(tracker.state.watches.a.page, 2);
  tracker.handle({ type: 'saved', watchId: 'a', ads: 80, newAds: 3 });
  tracker.handle({ type: 'regions', watchId: 'a', done: 1, total: 4 });
  assert.equal(tracker.state.watches.a.step, 'regions');
  tracker.handle({ type: 'done', watchId: 'a' });
  assert.equal(tracker.state.watches.a.state, 'done');
  assert.equal(tracker.state.watches.a.newAds, 3);
  tracker.handle({ type: 'page', watchId: 'b', page: 1, maxPages: 10, ads: 40 });
  tracker.handle({ type: 'error', watchId: 'b', blocked: true });
  assert.equal(tracker.state.watches.b.state, 'blocked');
  assert.equal(tracker.state.watches.c.state, 'skipped');
  tracker.finish();
  assert.ok(tracker.state.finishedAt);
  assert.ok(writes.length >= 7);
});
