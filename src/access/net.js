import { networkInterfaces } from 'node:os';

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((total, part) => total * 256 + part, 0);
}

function expandIpv6(ip) {
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  if (!ip.includes('::') && left.length !== 8) return null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map(group => Number.parseInt(group, 16));
}

export function inCidr(ip, cidr) {
  const [range, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  if (range.includes(':')) {
    const a = expandIpv6(ip.split('%')[0]);
    const b = expandIpv6(range);
    if (!a || !b) return false;
    for (let index = 0, remaining = bits; index < 8 && remaining > 0; index++, remaining -= 16) {
      const take = Math.min(16, remaining);
      const mask = (0xffff << (16 - take)) & 0xffff;
      if ((a[index] & mask) !== (b[index] & mask)) return false;
    }
    return true;
  }
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(range);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(b / size);
}

export function localAddresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces).flat().filter(entry => entry && !entry.internal).map(entry => entry.address);
}
