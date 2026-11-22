import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname } from 'node:path';

export class ScanBusyError extends Error {
  constructor() {
    super('ĐANG_QUÉT');
    this.code = 'SCAN_BUSY';
  }
}

// Keep the inode in place. The kernel releases the lock when the helper exits.
// The pipe ties the helper's lifetime to the scanner, including abrupt exits.
const program = `
  use Fcntl qw(:flock);
  use Errno qw(EAGAIN EWOULDBLOCK);
  open my $lock, ">>", $ARGV[0] or die "$!";
  if (!flock($lock, LOCK_EX | LOCK_NB)) {
    exit 75 if $! == EAGAIN || $! == EWOULDBLOCK;
    die "$!";
  }
  if ($ARGV[1] eq "hold") {
    $| = 1;
    print "locked\n";
    1 while read(STDIN, my $buffer, 1);
  }
`;

function legacyOwnerAlive(path) {
  try {
    const { pid } = JSON.parse(readFileSync(path, 'utf8')) ?? {};
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error instanceof SyntaxError || ['ENOENT', 'ESRCH'].includes(error.code)) return false;
    throw error;
  }
}

export async function isScanLocked(path) {
  if (legacyOwnerAlive(path)) return true;
  mkdirSync(dirname(path), { recursive: true });
  const probe = spawn('/usr/bin/perl', ['-e', program, path, 'probe'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  probe.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [code] = await once(probe, 'close');
  if (code === 75) return true;
  if (code !== 0) throw new Error(stderr || 'Không kiểm tra được khoá quét');
  return false;
}

export async function withLock(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  const helper = spawn('/usr/bin/perl', ['-e', program, path, 'hold']);
  helper.stdin.on('error', () => {});
  let stderr = '';
  helper.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(helper, 'close');
  try {
    await Promise.race([
      once(helper.stdout, 'data'),
      closed.then(([code]) => {
        if (code === 75) throw new ScanBusyError();
        throw new Error(stderr || 'Không lấy được khoá quét');
      }),
    ]);
    if (legacyOwnerAlive(path)) throw new ScanBusyError();
    return await fn();
  } finally {
    helper.stdin.end();
    await closed;
  }
}
