import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Mở nhiều tab ATC cùng lúc là nguyên nhân lớn khiến Google khoá. Cả máy chỉ được tối đa 2 tab ATC.
export const MAX_ATC_TABS = 2;
const ATC_HOST = 'adstransparency.google.com';
const BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc'];

export class TabLimitError extends Error {
  constructor(count) {
    super(`Đang có ${count} tab ATC mở ở trình duyệt khác — hoãn quét để tránh bị Google khoá.`);
    this.name = 'TabLimitError';
    this.count = count;
  }
}

export function isAtcUrl(url) {
  try { return new URL(url).hostname === ATC_HOST; } catch { return false; }
}

function browserScript(app) {
  return `if application "${app}" is running then
  set n to 0
  tell application "${app}"
    repeat with w in windows
      repeat with t in tabs of w
        if (URL of t as text) contains "${ATC_HOST}" then set n to n + 1
      end repeat
    end repeat
  end tell
  return n
end if
return 0`;
}

function runOsascript(script, timeout) {
  return new Promise(resolve => {
    execFile('osascript', ['-e', script], { timeout }, (error, stdout) => {
      const value = Number.parseInt(String(stdout).trim(), 10);
      resolve(error || !Number.isFinite(value) ? 0 : value);
    });
  });
}

// Đếm tab ATC đang mở ở các trình duyệt của người dùng (macOS). Gọi TRƯỚC khi mở trình duyệt quét.
// Không đọc được (không phải macOS, chưa cấp quyền) thì tính là 0.
export async function countExternalAtcTabs({ platform = process.platform, run = runOsascript, timeout = 5000 } = {}) {
  if (platform !== 'darwin') return 0;
  let total = 0;
  for (const app of BROWSERS) total += await run(browserScript(app), timeout);
  return total;
}

// Trả về số tab ATC lượt quét được dùng (1 hoặc 2). Chờ nếu trình duyệt khác đang giữ đủ 2 tab.
export async function acquireTabBudget({
  count = countExternalAtcTabs, log = console.error, maxWaitMs = 10 * 60_000, intervalMs = 30_000,
  wait = delay, max = MAX_ATC_TABS,
} = {}) {
  let external = await count();
  let waited = 0;
  if (external >= max) log(`Đang có ${external} tab ATC mở ở trình duyệt khác — chờ bớt tab rồi mới quét.`);
  while (external >= max && waited < maxWaitMs) {
    await wait(intervalMs);
    waited += intervalMs;
    external = await count();
  }
  if (external >= max) throw new TabLimitError(external);
  const budget = max - external;
  if (external > 0) log(`Đang có ${external} tab ATC mở ở trình duyệt khác — lượt này chỉ dùng ${budget} tab.`);
  return budget;
}
