import { inCidr, localAddresses } from './net.js';

// Mạng riêng bất kỳ (ZeroTier, NetBird, Headscale, WireGuard…): khai dải địa chỉ của mạng đó.
// config.json: { "access": { "provider": "cidr", "name": "ZeroTier", "cidrs": ["10.147.17.0/24"], "hostname": "norman" } }
export function cidrProvider({ name = 'Mạng riêng', cidrs = [], hostname = '' } = {}, { interfaces } = {}) {
  if (!Array.isArray(cidrs) || !cidrs.length) throw new Error('Cần khai "cidrs" cho cách truy cập này.');
  return {
    name,
    allows: ip => cidrs.some(range => inCidr(ip, range)),
    urls(port) {
      const ips = localAddresses(interfaces).filter(ip => cidrs.some(range => inCidr(ip, range)));
      return [...(hostname ? [hostname] : []), ...ips].map(host => `http://${host.includes(':') ? `[${host}]` : host}:${port}`);
    },
  };
}
