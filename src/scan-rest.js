export const REST_MS = 6 * 60 * 60 * 1000;

export function scanResumeAt(history, now = Date.now()) {
  for (const entry of [...history].reverse()) {
    if (entry.status === 'ok' && !entry.light) return null;
    if (entry.status === 'blocked' || entry.resumeAt) {
      const resume = entry.resumeAt ? Date.parse(entry.resumeAt) : Date.parse(entry.at) + REST_MS;
      return resume > now ? new Date(resume).toISOString() : null;
    }
  }
  return null;
}
