import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function syncToGitHub(root, execute = execFileAsync) {
  const run = (args) => execute('git', args, {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });

  try {
    const config = await readFile(join(root, 'config.json'), 'utf8');
    if (JSON.parse(config)?.sync !== true) return { pushed: false, reason: 'chưa bật' };
  } catch (error) {
    return { pushed: false, reason: error.code === 'ENOENT' ? 'chưa bật' : 'Không đọc được cấu hình đồng bộ' };
  }

  try {
    await run(['add', '--', 'data']);
    let changed = false;
    try {
      await run(['diff', '--cached', '--quiet', '--', 'data']);
    } catch (error) {
      if (error.code !== 1) throw error;
      changed = true;
    }

    if (changed) {
      await run(['commit', '-m', `Dữ liệu quét ${new Date().toISOString()}`, '--', 'data']);
    }
    const { stdout } = await run(['push', '--porcelain']);
    return /^=\t/m.test(stdout) && !/^[*+ -]\t/m.test(stdout)
      ? { pushed: false, reason: 'không đổi' }
      : { pushed: true };
  } catch (error) {
    return { pushed: false, reason: error.stderr?.trim() || error.message };
  }
}
