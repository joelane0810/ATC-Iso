import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const maxAgeMs = 3 * 60 * 60 * 1000;

function isAlive({ pid, startedAt }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(startedAt)
    || Date.now() - startedAt >= maxAgeMs) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export async function withLock(lockPath, fn) {
  const directory = dirname(lockPath);
  mkdirSync(directory, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, startedAt: Date.now(), id: randomUUID() });
  const temporary = `${lockPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, owner, { flag: 'wx' });
  try {
    for (;;) {
      try {
        // Publish the complete owner record atomically, without replacing a lock.
        linkSync(temporary, lockPath);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      try {
        const before = statSync(lockPath);
        let lock;
        try {
          lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (lock && isAlive(lock)) throw new Error('ĐANG_QUÉT');

        const current = statSync(lockPath);
        if (before.ino === current.ino && before.dev === current.dev) unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  } finally {
    unlinkSync(temporary);
  }

  try {
    return await fn();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
