import { startGateway } from './gateway.js';
import { inCidr, localAddresses } from './net.js';

// Tailscale: địa chỉ 100.64.0.0/10 và fd7a:115c:a1e0::/48. Tên máy trong mạng Tailscale (MagicDNS) ghi ở "hostname".
const ranges = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

// gateway: true → app tự có một máy riêng tên <hostname> trong mạng Tailscale (http://atc-iso), không phụ thuộc tên máy Mac.
export function tailscaleProvider({ hostname = 'atc-iso', domain = '', gateway = true } = {}, { interfaces } = {}) {
  let running = null;
  return {
    name: 'Tailscale',
    allows: ip => ranges.some(range => inCidr(ip, range)),
    urls(port) {
      if (gateway) return [`http://${hostname}`, ...(domain ? [`https://${hostname}.${domain}`] : [])];
      const names = [hostname, domain ? `${hostname}.${domain}` : null].filter(Boolean);
      const ips = localAddresses(interfaces).filter(ip => !ip.includes(':') && inCidr(ip, ranges[0]));
      return [...names, ...ips].map(host => `http://${host}:${port}`);
    },
    start({ root, port, log, launch = startGateway }) {
      if (!gateway || running) return running?.state ?? null;
      running = launch({ root, port, hostname, log });
      return running.state;
    },
    status: () => running?.state ?? null,
    stop: () => running?.stop(),
  };
}
