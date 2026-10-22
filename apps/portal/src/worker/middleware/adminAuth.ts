// Admin authentication (DESIGN §4.1, §13). Cloudflare Access sits in front of the admin host;
// this middleware does not trust that alone. Every request must carry a `Cf-Access-Jwt-Assertion`
// JWT that verifies against the team's published keys, with the right issuer and audience, and
// whose identity is on an allowlist. The reasons are in wiki/Portal.md → "Admin authentication".
import { createMiddleware } from "hono/factory";
import { verifyWithJwks } from "hono/utils/jwt/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import type { JWTPayload } from "hono/utils/jwt/types";
import { AppError } from "../lib/errors";
import { isLocalhost } from "../lib/hosts";
import { log } from "../lib/log";
import type { AppEnv } from "../types";

/** The actor recorded in the audit log for `wrangler dev` with DEV_AUTH=1. */
export const DEV_ACTOR = "dev@admin.localhost";

/** Keys are kept this long, then refetched on the next request. */
const KEY_TTL_MS = 10 * 60 * 1000;
/**
 * At most one fetch attempt this often per isolate, whether for a `kid` that isn't cached (key
 * rotation), a stale cache, or a retry after a failed fetch.
 */
const REFETCH_INTERVAL_MS = 60 * 1000;
/**
 * If a refresh fails, keys fetched within this long are still used rather than locking every
 * admin out during a certs-endpoint hiccup. Bounded, so a key Access withdrew isn't trusted for
 * long during an outage.
 */
const STALE_MAX_MS = 60 * 60 * 1000;

interface CachedKeys {
  keys: HonoJsonWebKey[];
  fetchedAt: number;
  /** The last fetch attempt, successful or not. */
  attemptedAt: number;
}

// Per isolate, keyed by certs URL. Losing it (a new isolate) only costs one fetch.
const keyCache = new Map<string, CachedKeys>();

/** For tests: forget every cached key set. */
export function clearAccessKeyCache(): void {
  keyCache.clear();
}

async function fetchKeys(url: string): Promise<HonoJsonWebKey[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("certs response has no keys");
  return body.keys as HonoJsonWebKey[];
}

/**
 * The cached keys, refreshed when stale or when `kid` is unknown, at most once per
 * REFETCH_INTERVAL_MS. With no usable cache a failed fetch throws (the request gets 401).
 */
async function keysFor(url: string, kid: string | undefined, onStale: () => void): Promise<HonoJsonWebKey[]> {
  const now = Date.now();
  const cached = keyCache.get(url);
  if (!cached) {
    const keys = await fetchKeys(url);
    keyCache.set(url, { keys, fetchedAt: now, attemptedAt: now });
    return keys;
  }
  const stale = now - cached.fetchedAt >= KEY_TTL_MS;
  const missing = !cached.keys.some((k) => k.kid === kid);
  if ((stale || missing) && now - cached.attemptedAt >= REFETCH_INTERVAL_MS) {
    cached.attemptedAt = now;
    try {
      const keys = await fetchKeys(url);
      keyCache.set(url, { keys, fetchedAt: now, attemptedAt: now });
      return keys;
    } catch (err) {
      if (now - cached.fetchedAt >= STALE_MAX_MS) throw err;
      onStale();
    }
  }
  if (now - cached.fetchedAt >= STALE_MAX_MS) throw new Error("certs too old to use");
  return cached.keys;
}

function kidOf(token: string): string | undefined {
  try {
    const header = JSON.parse(atob(token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))) as { kid?: unknown };
    return typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
}

/** Comma-separated var → trimmed, non-empty entries. */
function list(value: string | undefined, lowercase: boolean): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => (lowercase ? s.trim().toLowerCase() : s.trim()))
      .filter((s) => s.length > 0),
  );
}

/** A bare hostname such as `<team>.cloudflareaccess.com`; anything else is a misconfiguration. */
const TEAM_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

const unauthorized = () => new AppError("unauthorized", "Unauthorized.");
const forbidden = () => new AppError("forbidden", "Forbidden.");

/** The actor for a verified token, or null if its identity isn't allowed. */
function actorFor(payload: JWTPayload, env: Env): string | null {
  const email = typeof payload.email === "string" && payload.email !== "" ? payload.email : null;
  const service = typeof payload.common_name === "string" && payload.common_name !== "" ? payload.common_name : null;
  // Exactly one identity. Access never issues both; a token that has both is refused.
  if (email !== null && service === null) {
    const lower = email.toLowerCase();
    return list(env.ADMIN_EMAILS, true).has(lower) ? lower : null;
  }
  if (service !== null && email === null) {
    return list(env.ADMIN_SERVICE_CLIENTS, false).has(service) ? `svc:${service}` : null;
  }
  return null;
}

/**
 * Verifies the Access JWT and sets `actor` (the email, lowercase, or `svc:<client id>`). 401 for
 * a missing or invalid token, 403 for a valid token whose identity isn't allowed; neither says
 * why. `Cf-Access-Authenticated-User-Email` is never read: only the signed claim counts.
 *
 * Uses Hono's JWKS verifier (`verifyWithJwks`, the core of the `jwk` middleware) directly, because
 * `jwk` only reads `Authorization: Bearer …` and Access sends the bare token in its own header.
 */
export const adminAuth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    // Local development only: `wrangler dev --var DEV_AUTH:1` on a *.localhost host. Staging and
    // production hosts are never *.localhost, and their configs don't set DEV_AUTH.
    if (c.env.DEV_AUTH === "1" && isLocalhost(new URL(c.req.url).hostname)) {
      c.set("actor", DEV_ACTOR);
      return next();
    }

    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!token) throw unauthorized();

    const team = c.env.ACCESS_TEAM_DOMAIN;
    const aud = c.env.ACCESS_AUD;
    if (!team || !aud || !TEAM_DOMAIN.test(team)) {
      log.warn({ requestId: c.get("requestId"), outcome: "access_not_configured" });
      throw unauthorized();
    }

    const certsUrl = `https://${team}/cdn-cgi/access/certs`;
    let payload: JWTPayload;
    try {
      const keys = await keysFor(certsUrl, kidOf(token), () =>
        log.warn({ requestId: c.get("requestId"), outcome: "access_certs_stale" }),
      );
      payload = await verifyWithJwks(token, {
        keys,
        allowedAlgorithms: ["RS256"],
        verification: { iss: `https://${team}`, aud, exp: true, nbf: true },
      });
    } catch (err) {
      if (!(err instanceof Error && err.name.startsWith("Jwt"))) {
        log.warn({ requestId: c.get("requestId"), outcome: "access_verify_error", errorName: err instanceof Error ? err.name : typeof err });
      }
      throw unauthorized();
    }
    // Hono checks exp only when present; Access always sets it, so a token without one is refused.
    if (typeof payload.exp !== "number") throw unauthorized();

    const actor = actorFor(payload, c.env);
    if (actor === null) throw forbidden();
    c.set("actor", actor);
    return next();
  });
