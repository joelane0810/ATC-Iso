import { inCidr, localAddresses } from './net.js';

// Tailscale: địa chỉ 100.64.0.0/10 và fd7a:115c:a1e0::/48. Tên máy trong mạng Tailscale (MagicDNS) ghi ở "hostname".
const ranges = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

export function tailscaleProvider({ hostname = 'norman', domain = '' } = {}, { interfaces } = {}) {
  return {
    name: 'Tailscale',
    allows: ip => ranges.some(range => inCidr(ip, range)),
    urls(port) {
      const names = [hostname, domain ? `${hostname}.${domain}` : null].filter(Boolean);
      const ips = localAddresses(interfaces).filter(ip => !ip.includes(':') && inCidr(ip, ranges[0]));
      return [...names, ...ips].map(host => `http://${host}:${port}`);
    },
  };
}
