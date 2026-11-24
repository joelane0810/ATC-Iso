import { execFile } from 'node:child_process';

// Đo RAM thật: tiến trình máy chủ, mọi tiến trình con (quét, Chrome tự động, cổng truy cập)
// và các Chrome không giao diện do app mở. Đơn vị MB.
export function parsePs(text) {
  return text.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, rss, command]) => ({ pid: Number(pid), ppid: Number(ppid), mb: Math.round(Number(rss) / 1024), command }));
}

export function summarizeMemory(rows, rootPid) {
  const children = new Map();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const tree = [];
  const walk = (pid) => { for (const row of children.get(pid) ?? []) { tree.push(row); walk(row.pid); } };
  const root = rows.find(row => row.pid === rootPid);
  if (root) tree.push(root);
  walk(rootPid);
  const kind = (command) => /Chrome|chrome|Chromium/.test(command) ? 'chrome'
    : /atc-iso-gateway/.test(command) ? 'gateway' : /node/.test(command) ? 'node' : 'other';
  const groups = {};
  for (const row of tree) {
    const key = row.pid === rootPid ? 'server' : kind(row.command);
    groups[key] = (groups[key] ?? 0) + row.mb;
  }
  return { totalMb: tree.reduce((sum, row) => sum + row.mb, 0), groups, processes: tree.length };
}

export function measureMemory({ rootPid = process.pid, run = execFile } = {}) {
  return new Promise((resolve) => {
    run('ps', ['-axo', 'pid=,ppid=,rss=,command='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const usage = process.memoryUsage();
      const node = { rssMb: Math.round(usage.rss / 1048576), heapMb: Math.round(usage.heapUsed / 1048576) };
      if (error) return resolve({ node, error: error.message });
      resolve({ node, ...summarizeMemory(parsePs(String(stdout)), rootPid), at: new Date().toISOString() });
    });
  });
}
