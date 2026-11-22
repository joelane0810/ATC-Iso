import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);

test('installer finds a Homebrew pair outside PATH and writes absolute launchd paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atc installer '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'Fake Home');
  const local = join(home, '.local', 'bin');
  const brew = join(home, '.homebrew', 'bin');
  const tools = join(root, 'tools');
  const apps = join(root, 'Applications');
  const chrome = join(apps, 'Google Chrome.app', 'Contents', 'MacOS');
  const ops = join(root, 'ops');
  for (const dir of [local, brew, tools, chrome, ops]) await mkdir(dir, { recursive: true });
  const executable = (path, body) => writeFile(path, '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
  await executable(join(local, 'node'), `[[ "$2" != 'require("node:sqlite")' ]]`);
  await executable(join(brew, 'node'), `
    if [[ "$2" = 'require("node:sqlite")' ]]; then
      printf '%s' "$2" > sqlite-checked
    fi
    exit 0`);
  await executable(join(brew, 'npm'), '[[ "$*" = ci ]] && printf "%s" "$PWD" > npm-ran');
  await executable(join(chrome, 'Google Chrome'), 'exit 0');
  await executable(join(tools, 'uname'), 'echo Darwin');
  await executable(join(tools, 'plutil'), 'exit 0');
  await executable(join(tools, 'launchctl'), '[[ "$1" = bootstrap ]] || exit 1');
  await executable(join(tools, 'node'), 'exit 99');
  const sourcePath = new URL('../ops/install-macos.sh', import.meta.url).pathname;
  await execute('/bin/bash', ['-n', sourcePath]);
  const source = await readFile(sourcePath, 'utf8');
  const installer = join(ops, 'install-macos.sh');
  await writeFile(installer, source.replace('/Applications/Google Chrome.app', apps + '/Google Chrome.app'));
  await execute('/bin/bash', [installer], {
    cwd: root, env: { ...process.env, HOME: home, PATH: './relative::' + tools + ':relative' },
  });
  assert.equal(await readFile(join(root, 'npm-ran'), 'utf8'), root);
  assert.equal(await readFile(join(root, 'sqlite-checked'), 'utf8'), 'require("node:sqlite")');
  for (const job of ['server', 'scan']) {
    const plist = await readFile(join(home, 'Library', 'LaunchAgents', 'com.atciso.' + job + '.plist'), 'utf8');
    assert.ok(plist.includes('<string>' + join(brew, 'node') + '</string>'));
    assert.ok(plist.includes('<string>' + join(root, 'bin', job + '.js') + '</string>'));
    const path = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)[1];
    assert.ok(path.split(':').every(dir => dir.startsWith('/')));
    assert.equal(path.split(':')[0], brew);
  }
});
