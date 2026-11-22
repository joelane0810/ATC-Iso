// Bật "cổng" Tailscale riêng của app (một máy tên atc-iso trong mạng Tailscale, chuyển về 127.0.0.1:<port>).
// Chạy kèm máy chủ web, tự bật lại nếu tắt. Lần đầu cần duyệt đăng nhập: đường dẫn hiện ở loginUrl.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export function gatewayBinary(root, { os = platform(), cpu = arch() } = {}) {
  if (os !== 'darwin') return null;
  const name = `atc-iso-gateway-darwin-${cpu === 'arm64' ? 'arm64' : 'amd64'}`;
  const packed = join(root, 'gateway', 'bin', `${name}.gz`);
  if (!existsSync(packed)) return null;
  const dir = join(root, 'data', 'gateway');
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, name);
  const stamp = join(dir, `${name}.size`);
  const size = String(readFileSync(packed).length);
  if (!existsSync(binary) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== size) {
    writeFileSync(binary, gunzipSync(readFileSync(packed)));
    chmodSync(binary, 0o755);
    writeFileSync(stamp, size);
  }
  return binary;
}

export function startGateway({ root, port, hostname, log = console.error, spawnProcess = spawn, binary = gatewayBinary(root) }) {
  const state = { hostname, running: false, loginUrl: null, error: null };
  if (!binary) {
    state.error = 'Máy này chưa có cổng Tailscale cho app.';
    return { state, stop() {} };
  }
  let child;
  let stopped = false;
  const pidFile = join(root, 'data', 'gateway', 'pid');
  // Máy chủ cũ bị tắt đột ngột có thể để lại cổng cũ: tắt nó trước để không chạy hai cổng cùng tên.
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    if (command.includes('atc-iso-gateway')) process.kill(pid, 'SIGTERM');
  } catch {}
  let delay = 2000;
  const run = () => {
    child = spawnProcess(binary, ['-hostname', hostname, '-target', `http://127.0.0.1:${port}`, '-dir', join(root, 'data', 'gateway', 'state')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const read = chunk => {
      const text = String(chunk);
      const login = text.match(/https:\/\/login\.tailscale\.com\/a\/[\w-]+/);
      if (login) state.loginUrl = login[0];
      if (text.includes('Cổng ATC Iso sẵn sàng')) { state.running = true; state.loginUrl = null; }
      for (const line of text.split('\n')) if (line.trim()) log(`[cổng Tailscale] ${line.trim()}`);
    };
    try { if (child.pid) writeFileSync(pidFile, String(child.pid)); } catch {}
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('exit', code => {
      state.running = false;
      if (stopped) return;
      state.error = `Cổng Tailscale dừng (mã ${code}), đang bật lại.`;
      setTimeout(run, delay).unref?.();
      delay = Math.min(delay * 2, 60_000);
    });
  };
  run();
  return { state, stop() { stopped = true; child?.kill(); } };
}
