// Test Cloudflare Access: a locally generated RSA key pair, a stubbed JWKS endpoint and a JWT
// signer. The Access values below are fakes set for Vitest only (vitest.config.ts); no real team
// domain or AUD is ever in the repo.
import { sign } from "hono/utils/jwt/jwt";
import type { JWTPayload } from "hono/utils/jwt/types";
import { vi } from "vitest";
import { clearAccessKeyCache } from "../middleware/adminAuth";

export const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
export const AUD = "test-aud-0000000000000000000000000000000000000000000000000000000000";
export const ADMIN_EMAIL = "admin@example.com";
export const SERVICE_CLIENT = "test-client-id.access";
export const CERTS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;
export const ADMIN_ORIGIN = "http://admin.localhost:8787";

type Jwk = JsonWebKey & { kid: string; alg: string };

const ALGORITHMS = {
  RS256: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  RS384: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
} as const;

/** A key pair as JWKs carrying `kid` and `alg`, as Access publishes them. */
export async function keyPair(kid: string, alg: keyof typeof ALGORITHMS = "RS256"): Promise<{ publicJwk: Jwk; privateJwk: Jwk }> {
  const pair = (await crypto.subtle.generateKey(ALGORITHMS[alg], true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { publicJwk: { ...publicJwk, kid, alg }, privateJwk: { ...privateJwk, kid, alg } };
}

/** The key Access "publishes", and one it doesn't (a token signed by someone else). */
export const accessKey = await keyPair("access-key-1");
export const otherKey = await keyPair("access-key-1");

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A user token as Access issues it; override or delete (`undefined`) any claim. */
export function userClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  const now = nowSeconds();
  return strip({
    aud: [AUD],
    email: ADMIN_EMAIL,
    exp: now + 3600,
    iat: now,
    nbf: now,
    iss: `https://${TEAM_DOMAIN}`,
    type: "app",
    sub: "00000000-0000-0000-0000-000000000001",
    ...overrides,
  });
}

/** A service-token JWT: `common_name` is the token's client ID, there is no email. */
export function serviceClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return userClaims({ email: undefined, sub: "", common_name: SERVICE_CLIENT, ...overrides });
}

function strip(claims: Record<string, unknown>): JWTPayload {
  return Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined)) as JWTPayload;
}

export function signJwt(claims: JWTPayload, key: Jwk = accessKey.privateJwk): Promise<string> {
  return sign(claims, key);
}

/**
 * Stubs `fetch` so the certs URL returns the published key. Returns the spy, so a test can count
 * JWKS fetches. Also clears the middleware's key cache, so each test starts cold.
 */
export function stubAccessCerts(keys: Jwk[] = [accessKey.publicJwk]) {
  clearAccessKeyCache();
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new Request(input).url;
    if (url === CERTS_URL) return Response.json({ keys });
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

/** Headers for an authenticated, same-origin admin JSON request. */
export async function adminHeaders(claims: JWTPayload = userClaims()): Promise<Record<string, string>> {
  return {
    "Cf-Access-Jwt-Assertion": await signJwt(claims),
    Origin: ADMIN_ORIGIN,
    "Content-Type": "application/json",
  };
}
