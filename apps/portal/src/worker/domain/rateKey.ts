// Rate-limiter keys (DESIGN §13): enrolment and the guest session swap are limited per client IP.

/**
 * A rate limiter's key for a client address, prefixed by `scope` (one key space per limiter).
 * IPv4 is keyed by address. IPv6 is keyed by its /64, because one subscriber usually holds a whole
 * /64 and could otherwise rotate through 2^64 keys. Anything unparseable is keyed as given.
 */
export function ipRateKey(scope: string, ip: string | undefined): string {
  if (!ip) return `${scope}:unknown`;
  if (!ip.includes(":")) return `${scope}:${ip}`;
  const [head = "", tail, extra] = ip.toLowerCase().split("::");
  if (extra !== undefined) return `${scope}:${ip}`;
  const part = (s: string) => (s === "" ? [] : s.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])));
  const left = part(head);
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(8 - left.length - part(tail).length, 0)).fill("0"), ...part(tail)];
  const prefix = groups.slice(0, 4);
  if (prefix.length < 4 || !prefix.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return `${scope}:${ip}`;
  return `${scope}:${prefix.map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
