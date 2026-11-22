import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { syncToGitHub } from '../src/sync.js';

test('syncToGitHub', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atc iso sync '));
  const originalPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  });

  const toolsDir = join(root, 'tools');
  const fakeGit = join(toolsDir, 'git');
  await mkdir(toolsDir);
  await writeFile(fakeGit, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync('calls', JSON.stringify(process.argv.slice(2)) + '\\n');
const scenario = fs.readFileSync('scenario', 'utf8');
const command = process.argv[2];
if (command === 'diff' && scenario !== 'unchanged') process.exit(1);
if (command === 'push' && scenario === 'broken') {
  fs.writeSync(2, 'remote unavailable');
  process.exit(1);
}
`);
  await chmod(fakeGit, 0o755);
  process.env.PATH = [toolsDir, originalPath].join(delimiter);

  async function run(scenario) {
    await writeFile(join(root, 'scenario'), scenario);
    await writeFile(join(root, 'calls'), '');
    const result = await syncToGitHub(root);
    const calls = (await readFile(join(root, 'calls'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    return { result, calls };
  }

  await t.test('đẩy dữ liệu mới', async () => {
    const { result, calls } = await run('changed');
    assert.deepEqual(result, { pushed: true });
    assert.deepEqual(calls.map(([command]) => command), ['add', 'diff', 'commit', 'push']);
    assert.deepEqual(calls[0], ['add', '--', 'data']);
    assert.deepEqual(calls[1], ['diff', '--cached', '--quiet', '--', 'data']);
    assert.deepEqual(calls[2].slice(1, 2), ['-m']);
    assert.match(calls[2][2], /^Dữ liệu quét \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(calls[2].slice(3), ['--', 'data']);
  });

  await t.test('không đổi thì bỏ qua commit và push', async () => {
    const { result, calls } = await run('unchanged');
    assert.deepEqual(result, { pushed: false, reason: 'không đổi' });
    assert.deepEqual(calls.map(([command]) => command), ['add', 'diff']);
  });

  await t.test('remote hỏng thì trả lỗi mà không ném', async () => {
    const { result, calls } = await run('broken');
    assert.equal(result.pushed, false);
    assert.match(result.reason, /remote unavailable/);
    assert.equal(calls.at(-1)[0], 'push');
  });
});
