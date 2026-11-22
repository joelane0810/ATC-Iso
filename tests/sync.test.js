import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { syncToGitHub } from '../src/sync.js';

test('sync requires opt-in, reports denied push, and retries pending commits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc iso sync '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  const calls = [];
  let changed = true;
  let denied = true;
  let pending = false;
  async function execute(command, args, options) {
    assert.equal(command, 'git');
    assert.equal(options.cwd, root);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options.timeout, 60_000);
    calls.push(args);
    if (args[0] === 'diff' && changed) throw Object.assign(new Error('changed'), { code: 1 });
    if (args[0] === 'commit') {
      pending = true;
      changed = false;
    }
    if (args[0] === 'push') {
      if (denied) throw Object.assign(new Error('push failed'), { stderr: 'remote unavailable\n' });
      const stdout = pending ? ' \trefs/heads/main:refs/heads/main\tupdated' : '=\trefs/heads/main:refs/heads/main\t[up to date]';
      pending = false;
      return { stdout };
    }
  }
  const run = () => syncToGitHub(root, execute);
  assert.deepEqual(await run(), { pushed: false, reason: 'chưa bật' });
  await writeFile(config, '{"sync":"true"}');
  assert.deepEqual(await run(), { pushed: false, reason: 'chưa bật' });
  assert.deepEqual(calls, []);

  await writeFile(config, '{"sync":true}');
  assert.deepEqual(await run(), { pushed: false, reason: 'remote unavailable' });
  assert.deepEqual(calls.map(([command]) => command), ['add', 'diff', 'commit', 'push']);
  assert.deepEqual(calls[2].slice(3), ['--', 'data']);

  calls.length = 0;
  denied = false;
  assert.deepEqual(await run(), { pushed: true });
  assert.deepEqual(calls.map(([command]) => command), ['add', 'diff', 'push']);
  assert.deepEqual(await run(), { pushed: false, reason: 'không đổi' });
});
