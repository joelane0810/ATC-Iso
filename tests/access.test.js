import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAccess, DEFAULT_ACCESS, readAccessConfig } from '../src/access/index.js';
import { inCidr } from '../src/access/net.js';

const interfaces = {
  en0: [{ address: '192.168.1.224', family: 'IPv4', internal: false }],
  utun4: [{ address: '100.90.11.60', family: 'IPv4', internal: false }, { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }],
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
};

test('inCidr handles IPv4 and IPv6 ranges', () => {
  assert.equal(inCidr('100.90.11.60', '100.64.0.0/10'), true);
  assert.equal(inCidr('100.128.0.1', '100.64.0.0/10'), false);
  assert.equal(inCidr('fd7a:115c:a1e0:ab12::5', 'fd7a:115c:a1e0::/48'), true);
  assert.equal(inCidr('fd7a:115c:a1e1::5', 'fd7a:115c:a1e0::/48'), false);
});

test('tailscale is the default: only tailnet and this machine get in', () => {
  const access = createAccess(DEFAULT_ACCESS, { interfaces });
  assert.equal(access.allows('127.0.0.1'), true);
  assert.equal(access.allows('::1'), true);
  assert.equal(access.allows('::ffff:100.101.5.9'), true);
  assert.equal(access.allows('fd7a:115c:a1e0::9'), true);
  assert.equal(access.allows('192.168.1.50'), false);
  assert.equal(access.allows('::ffff:192.168.1.50'), false);
  assert.deepEqual(access.urls(4317), ['http://atc-iso']);
  const direct = createAccess({ provider: 'tailscale', hostname: 'atc-iso', gateway: false }, { interfaces });
  assert.deepEqual(direct.urls(4317), ['http://atc-iso:4317', 'http://100.90.11.60:4317']);
});

test('providers swap through config without code changes', () => {
  const lan = createAccess({ provider: 'lan' }, { interfaces });
  assert.equal(lan.allows('192.168.1.50'), true);
  assert.equal(lan.allows('100.101.5.9'), false);
  assert.deepEqual(lan.urls(4317), ['http://192.168.1.224:4317']);
  const zerotier = createAccess({ provider: 'cidr', name: 'ZeroTier', cidrs: ['10.147.17.0/24'], hostname: 'norman' }, { interfaces });
  assert.equal(zerotier.name, 'ZeroTier');
  assert.equal(zerotier.allows('10.147.17.8'), true);
  assert.equal(zerotier.allows('100.101.5.9'), false);
  assert.throws(() => createAccess({ provider: 'khong-co' }), /Không có cách truy cập/);
});

test('readAccessConfig merges config.json over the default', t => {
  const root = mkdtempSync(join(tmpdir(), 'atc-access-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readAccessConfig(root), DEFAULT_ACCESS);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ showBrowser: false, access: { domain: 'tail1234.ts.net' } }));
  const config = readAccessConfig(root);
  assert.equal(config.provider, 'tailscale');
  assert.deepEqual(createAccess(config, { interfaces }).urls(4317), ['http://atc-iso', 'https://atc-iso.tail1234.ts.net']);
});

test('tailscale gateway starts once, reports login link, restarts and stops', async t => {
  const { EventEmitter } = await import('node:events');
  const { startGateway } = await import('../src/access/gateway.js');
  const root = mkdtempSync(join(tmpdir(), 'atc-gw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const children = [];
  const spawnProcess = (binary, args) => {
    const child = Object.assign(new EventEmitter(), { pid: 0, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.killed = true; } });
    child.args = args;
    children.push(child);
    return child;
  };
  const gw = startGateway({ root, port: 4317, hostname: 'atc-iso', log: () => {}, spawnProcess, binary: '/bin/true' });
  assert.deepEqual(children[0].args.slice(0, 4), ['-hostname', 'atc-iso', '-target', 'http://127.0.0.1:4317']);
  children[0].stderr.emit('data', 'To start this tsnet server, go to: https://login.tailscale.com/a/abc123\n');
  assert.equal(gw.state.loginUrl, 'https://login.tailscale.com/a/abc123');
  children[0].stderr.emit('data', 'Cổng ATC Iso sẵn sàng: http://atc-iso\n');
  assert.equal(gw.state.running, true);
  assert.equal(gw.state.loginUrl, null);
  gw.stop();
  assert.equal(children[0].killed, true);
  children[0].emit('exit', 0);
  assert.equal(children.length, 1);
  const missing = startGateway({ root, port: 4317, hostname: 'atc-iso', log: () => {}, spawnProcess, binary: null });
  assert.match(missing.state.error, /chưa có cổng/);
});
