/**
 * Pure CIDR math for the Cloudflare address allowlist.
 *
 * Deliberately free of runtime imports so the regression runner can load it directly —
 * the rest of src/ uses extensionless imports, which Node's ESM loader cannot resolve.
 * KV caching and the periodic refresh live in cf-ranges-cache.ts.
 */

/**
 * The effective allowlist is the union of Cloudflare's published ranges and the CIDR list
 * shipped to routers in openwrt-packages/.../etc/cf-ip-speed-client/ip.txt. The shipped list
 * is wider in one place (104.16.0.0/12 vs the published /13 + 104.24.0.0/14), so a
 * published-only allowlist would silently reject deployed clients whose best node lands in
 * 104.28.0.0/14-104.31.0.0/16. Every entry is Cloudflare-owned space either way.
 */
export const CF_IPV4_CIDRS: readonly string[] = [
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '104.16.0.0/12',
  '108.162.192.0/18',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '162.158.0.0/15',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '188.114.96.0/20',
  '190.93.240.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17'
];

export const CF_IPV6_CIDRS: readonly string[] = [
  '2400:cb00::/32',
  '2405:8100::/32',
  '2405:b500::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
];

interface Ipv4Range {
  base: number;
  prefix: number;
}

interface Ipv6Range {
  base: number[];
  prefix: number;
}

export interface ParsedRanges {
  v4: Ipv4Range[];
  v6: Ipv6Range[];
}

/**
 * Returns the address as a number in [0, 2^32). Kept in float space on purpose: bitwise
 * operators in JS coerce to int32, which makes any address above 127.255.255.255 negative.
 */
export function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    out = out * 256 + octet;
  }
  return out;
}

function parseGroup(part: string): number | null {
  return /^[0-9a-fA-F]{1,4}$/.test(part) ? Number.parseInt(part, 16) : null;
}

export function ipv6ToGroups(value: string): number[] | null {
  let address = value.trim();
  if (!address.includes(':') || address.length > 45 || /[[\]%]/.test(address)) {
    return null;
  }

  // A trailing dotted-quad (::ffff:1.2.3.4) becomes the last two 16-bit groups.
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const packed = ipv4ToInt(tail);
    if (packed === null) {
      return null;
    }
    address = `${address.slice(0, lastColon + 1)}${Math.floor(packed / 0x10000).toString(16)}:${(packed % 0x10000).toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const groups: number[] = [];

  for (const part of head) {
    const parsed = parseGroup(part);
    if (parsed === null) {
      return null;
    }
    groups.push(parsed);
  }

  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) {
      return null;
    }
    for (let index = 0; index < fill; index += 1) {
      groups.push(0);
    }
  }

  for (const part of rest) {
    const parsed = parseGroup(part);
    if (parsed === null) {
      return null;
    }
    groups.push(parsed);
  }

  return groups.length === 8 ? groups : null;
}

/**
 * Groups an address into the block its ISP most likely assigned, so abuse controls survive a
 * client cycling addresses within one line. /24 for v4 and /48 for v6 are the usual
 * granularity of a residential allocation. Returns '' for anything unparsable.
 */
export function ipPrefix(ip: string): string {
  if (ipv4ToInt(ip) !== null) {
    return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  }
  const groups = ipv6ToGroups(ip);
  return groups ? `${groups.slice(0, 3).map((part) => part.toString(16)).join(':')}::/48` : '';
}

export function parseCidrList(lines: readonly string[]): ParsedRanges {
  const ranges: ParsedRanges = { v4: [], v6: [] };

  for (const line of lines) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) {
      continue;
    }
    const [address, prefixText] = entry.split('/');
    const prefix = Number.parseInt(prefixText ?? '', 10);
    if (!Number.isInteger(prefix) || prefix < 0) {
      continue;
    }

    const v4 = ipv4ToInt(address);
    if (v4 !== null) {
      if (prefix <= 32) {
        ranges.v4.push({ base: v4, prefix });
      }
      continue;
    }

    const v6 = ipv6ToGroups(address);
    if (v6 && prefix <= 128) {
      ranges.v6.push({ base: v6, prefix });
    }
  }

  return ranges;
}

function ipv4InCidr(ip: number, range: Ipv4Range): boolean {
  if (range.prefix === 0) {
    return true;
  }
  const size = 2 ** (32 - range.prefix);
  return Math.floor(ip / size) === Math.floor(range.base / size);
}

function ipv6InCidr(groups: number[], range: Ipv6Range): boolean {
  let remaining = range.prefix;
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((groups[index] & mask) !== (range.base[index] & mask)) {
      return false;
    }
    remaining -= take;
  }
  return true;
}

export function isCloudflareIp(ip: string, ranges: ParsedRanges): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    return ranges.v4.some((range) => ipv4InCidr(v4, range));
  }
  const v6 = ipv6ToGroups(ip);
  if (v6) {
    return ranges.v6.some((range) => ipv6InCidr(v6, range));
  }
  return false;
}

let bundled: ParsedRanges | undefined;

export function bundledRanges(): ParsedRanges {
  bundled ??= parseCidrList([...CF_IPV4_CIDRS, ...CF_IPV6_CIDRS]);
  return bundled;
}

export function mergeRanges(base: ParsedRanges, extra: ParsedRanges): ParsedRanges {
  const seenV4 = new Set(base.v4.map((range) => `${range.base}/${range.prefix}`));
  const seenV6 = new Set(base.v6.map((range) => `${range.base.join(':')}/${range.prefix}`));
  const merged: ParsedRanges = { v4: [...base.v4], v6: [...base.v6] };

  for (const range of extra.v4) {
    const key = `${range.base}/${range.prefix}`;
    if (!seenV4.has(key)) {
      seenV4.add(key);
      merged.v4.push(range);
    }
  }
  for (const range of extra.v6) {
    const key = `${range.base.join(':')}/${range.prefix}`;
    if (!seenV6.has(key)) {
      seenV6.add(key);
      merged.v6.push(range);
    }
  }

  return merged;
}

const ANCHOR_PROBES = ['104.16.0.1', '172.64.0.1', '162.158.0.1', '103.21.244.1', '2606:4700::1', '2400:cb00::1'];
const FORBIDDEN_PROBES = ['10.0.0.1', '127.0.0.1', '172.16.0.1', '192.168.1.1', '0.0.0.1', '224.0.0.1', '8.8.8.8', '1.1.1.1'];

const MIN_IPV4_ENTRIES = 10;
const MAX_IPV4_ENTRIES = 60;
const MIN_IPV6_ENTRIES = 4;
const MAX_IPV6_ENTRIES = 30;
const MIN_IPV4_PREFIX = 12;
const MAX_IPV4_PREFIX = 24;

/**
 * A fetched list may only widen the allowlist within Cloudflare's own space, so it is
 * rejected wholesale unless it still looks like Cloudflare's: plausible entry counts,
 * prefixes in range, every anchor still covered, and no private or public-resolver address
 * inside. Returns undefined when the list is acceptable.
 */
export function validateFetchedRanges(v4: string[], v6: string[]): string | undefined {
  if (v4.length < MIN_IPV4_ENTRIES || v4.length > MAX_IPV4_ENTRIES) {
    return `unexpected_v4_count:${v4.length}`;
  }
  if (v6.length < MIN_IPV6_ENTRIES || v6.length > MAX_IPV6_ENTRIES) {
    return `unexpected_v6_count:${v6.length}`;
  }

  const parsed = parseCidrList([...v4, ...v6]);
  if (parsed.v4.length !== v4.length || parsed.v6.length !== v6.length) {
    return 'unparsable_entry';
  }
  for (const range of parsed.v4) {
    if (range.prefix < MIN_IPV4_PREFIX || range.prefix > MAX_IPV4_PREFIX) {
      return `implausible_v4_prefix:${range.prefix}`;
    }
  }
  for (const probe of ANCHOR_PROBES) {
    if (!isCloudflareIp(probe, parsed)) {
      return `anchor_missing:${probe}`;
    }
  }
  for (const probe of FORBIDDEN_PROBES) {
    if (isCloudflareIp(probe, parsed)) {
      return `forbidden_address_covered:${probe}`;
    }
  }
  return undefined;
}
