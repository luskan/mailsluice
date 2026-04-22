import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class PrivateHostError extends Error {}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const byte = Number(p);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    n = (n << 8) | byte;
  }
  return n >>> 0;
}

function inRange(ip: number, prefix: string, bits: number): boolean {
  const base = ipv4ToInt(prefix)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

function isPrivateIPv4(addr: string): boolean {
  const ip = ipv4ToInt(addr);
  if (ip === null) return false;
  return (
    inRange(ip, '0.0.0.0', 8) ||        // "this network"
    inRange(ip, '10.0.0.0', 8) ||       // RFC1918
    inRange(ip, '127.0.0.0', 8) ||      // loopback
    inRange(ip, '169.254.0.0', 16) ||   // link-local / metadata (AWS/GCP 169.254.169.254)
    inRange(ip, '172.16.0.0', 12) ||    // RFC1918
    inRange(ip, '192.0.0.0', 24) ||     // IETF reserved
    inRange(ip, '192.168.0.0', 16) ||   // RFC1918
    inRange(ip, '100.64.0.0', 10) ||    // CGNAT
    inRange(ip, '224.0.0.0', 4) ||      // multicast
    inRange(ip, '240.0.0.0', 4)         // reserved / broadcast
  );
}

function isPrivateIPv6(addr: string): boolean {
  const a = addr.toLowerCase().split('%')[0]!;
  if (a === '::' || a === '::1') return true;
  if (a.startsWith('fe80:') || a.startsWith('fe8')) return true;  // link-local fe80::/10
  if (a.startsWith('fc') || a.startsWith('fd')) return true;      // ULA fc00::/7
  if (a.startsWith('ff')) return true;                            // multicast
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  const mapped = a.match(/^::ffff:([0-9.]+)$/i);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

export function isPrivateAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) return isPrivateIPv4(addr);
  if (kind === 6) return isPrivateIPv6(addr);
  return false;
}

export async function assertPublicHost(host: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  // If the host is already a literal IP, resolve() is skipped.
  const literal = isIP(host);
  if (literal !== 0) {
    if (isPrivateAddress(host)) {
      throw new PrivateHostError(
        `host ${host} is a private/loopback address; set APP_ALLOW_PRIVATE_SOURCES=1 to allow.`,
      );
    }
    return;
  }
  let results;
  try {
    results = await lookup(host, { all: true });
  } catch (err) {
    // DNS failure: let the downstream connection attempt produce the error message.
    void err;
    return;
  }
  for (const r of results) {
    if (isPrivateAddress(r.address)) {
      throw new PrivateHostError(
        `host ${host} resolves to a private/loopback address (${r.address}); set APP_ALLOW_PRIVATE_SOURCES=1 to allow.`,
      );
    }
  }
}
