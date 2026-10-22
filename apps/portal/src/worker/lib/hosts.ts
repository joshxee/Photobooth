// Host helpers. Hostnames come from vars (GALLERY_HOST, ADMIN_HOST); nothing hard-codes a domain.

/** `*.localhost` (any port stripped by the caller): local development under `wrangler dev`. */
export function isLocalhost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h.endsWith(".localhost") && h.length > ".localhost".length;
}

/** The origin a browser uses for a configured host: https, except http for local `*.localhost`. */
export function originOf(host: string): string {
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  return `${isLocalhost(hostname) ? "http" : "https"}://${host.toLowerCase()}`;
}
