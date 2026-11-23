// Tiến độ lượt quét, ghi ra data/scan-progress.json để máy chủ web đọc (lượt quét chạy ở tiến trình riêng).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function progressPath(root) {
  return join(root, 'data', 'scan-progress.json');
}

export function createProgressTracker({ file, now = () => new Date(), write = writeAtomic } = {}) {
  const state = { startedAt: now().toISOString(), finishedAt: null, order: [], watches: {} };
  const save = () => { try { write(file, state); } catch {} };
  const entry = id => (state.watches[id] ??= { state: 'queued' });
  return {
    state,
    handle(event) {
      switch (event.type) {
        case 'start':
          state.order = [...event.watchIds];
          for (const id of event.watchIds) state.watches[id] = { state: 'queued' };
          break;
        case 'page':
          Object.assign(entry(event.watchId), { state: 'scanning', step: 'pages', page: event.page, maxPages: event.maxPages, ads: event.ads });
          break;
        case 'saved':
          Object.assign(entry(event.watchId), { ads: event.ads, newAds: event.newAds, step: 'saved' });
          break;
        case 'regions':
          Object.assign(entry(event.watchId), { state: 'scanning', step: 'regions', regionsDone: event.done, regionsTotal: event.total });
          break;
        case 'done':
          Object.assign(entry(event.watchId), { state: 'done', step: null, finishedAt: now().toISOString() });
          break;
        case 'error':
          Object.assign(entry(event.watchId), { state: event.blocked ? 'blocked' : 'error', step: null });
          for (const id of state.order) if (state.watches[id]?.state === 'queued') state.watches[id].state = 'skipped';
          break;
        default:
          return;
      }
      save();
    },
    finish() {
      state.finishedAt = now().toISOString();
      for (const id of state.order) if (state.watches[id]?.state === 'queued') state.watches[id].state = 'skipped';
      save();
    },
  };
}

function writeAtomic(file, value) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, file);
}

export function readProgress(root) {
  try {
    return JSON.parse(readFileSync(progressPath(root), 'utf8'));
  } catch {
    return null;
  }
}
