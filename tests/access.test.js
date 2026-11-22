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
  assert.deepEqual(access.urls(4317), ['http://norman:4317', 'http://100.90.11.60:4317']);
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
  assert.deepEqual(createAccess(config, { interfaces }).urls(4317).slice(0, 2), ['http://norman:4317', 'http://norman.tail1234.ts.net:4317']);
});
