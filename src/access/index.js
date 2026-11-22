// Cách cho máy khác truy cập app — dạng "cắm rút": mỗi cách là một tệp trong thư mục này.
// Đổi cách bằng config.json: { "access": { "provider": "tailscale", "hostname": "atc-iso" } }
// Thêm cách mới (ZeroTier, NetBird, Headscale…): dùng provider "cidr" với dải địa chỉ của mạng đó,
// hoặc viết một tệp mới theo cùng mẫu rồi ghi tên vào bảng providers bên dưới. Không phải sửa chỗ khác.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cidrProvider } from './cidr.js';
import { lanProvider } from './lan.js';
import { tailscaleProvider } from './tailscale.js';

export const providers = { tailscale: tailscaleProvider, lan: lanProvider, cidr: cidrProvider };
export const DEFAULT_ACCESS = { provider: 'tailscale', hostname: 'atc-iso', gateway: true };

export function readAccessConfig(root) {
  try {
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    return config?.access && typeof config.access === 'object' ? { ...DEFAULT_ACCESS, ...config.access } : DEFAULT_ACCESS;
  } catch {
    return DEFAULT_ACCESS;
  }
}

export function createAccess(config = DEFAULT_ACCESS, { interfaces } = {}) {
  const factory = providers[config.provider];
  if (!factory) throw new Error(`Không có cách truy cập "${config.provider}". Có: ${Object.keys(providers).join(', ')}.`);
  const provider = factory(config, { interfaces });
  return {
    name: provider.name,
    // Máy này luôn vào được; máy khác chỉ vào được qua mạng đã chọn.
    allows(address) {
      const ip = normalizeIp(address);
      return isLoopback(ip) || provider.allows(ip);
    },
    urls: (port) => provider.urls(port),
    // Cách truy cập nào cần chạy tiến trình riêng (vd. cổng Tailscale) thì bật ở đây; cách khác bỏ qua.
    start: (options) => provider.start?.(options) ?? null,
    status: () => provider.status?.() ?? null,
    stop: () => provider.stop?.(),
  };
}

export function normalizeIp(address = '') {
  const value = String(address).trim().toLowerCase();
  return value.startsWith('::ffff:') && value.includes('.') ? value.slice(7) : value;
}

export function isLoopback(ip) {
  return ip === '::1' || /^127\./.test(ip);
}
