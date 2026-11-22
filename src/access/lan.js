import { inCidr, localAddresses } from './net.js';

// Cùng wifi/mạng nội bộ.
const ranges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'];

export function lanProvider(_config, { interfaces } = {}) {
  return {
    name: 'Cùng wifi',
    allows: ip => ranges.some(range => inCidr(ip, range)),
    urls: port => localAddresses(interfaces).filter(ip => !ip.includes(':') && ranges.some(range => inCidr(ip, range)))
      .map(ip => `http://${ip}:${port}`),
  };
}
