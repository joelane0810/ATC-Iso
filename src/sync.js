import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function syncToGitHub(root) {
  const run = (args) => execFileAsync('git', args, { cwd: root });

  try {
    await run(['add', '--', 'data']);
    try {
      await run(['diff', '--cached', '--quiet', '--', 'data']);
      return { pushed: false, reason: 'không đổi' };
    } catch (error) {
      if (error.code !== 1) throw error;
    }

    await run(['commit', '-m', `Dữ liệu quét ${new Date().toISOString()}`, '--', 'data']);
    await run(['push']);
    return { pushed: true };
  } catch (error) {
    return { pushed: false, reason: error.stderr?.trim() || error.message };
  }
}
