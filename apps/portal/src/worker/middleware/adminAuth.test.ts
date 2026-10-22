import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostApp } from "../lib/hostApp";
import {
  ADMIN_EMAIL,
  AUD,
  CERTS_URL,
  SERVICE_CLIENT,
  TEAM_DOMAIN,
  otherKey,
  serviceClaims,
  signJwt,
  stubAccessCerts,
  userClaims,
} from "../test/access";
import { DEV_ACTOR, adminAuth } from "./adminAuth";

const ADMIN = "http://admin.localhost:8787";

function app() {
  const a = createHostApp("admin");
  a.use(adminAuth());
  a.get("/whoami", (c) => c.json({ actor: c.get("actor") }));
  return a;
}

function call(token: string | null, overrides: Partial<Env> = {}, url = `${ADMIN}/whoami`, headers: HeadersInit = {}) {
  const h = new Headers(headers);
  if (token !== null) h.set("Cf-Access-Jwt-Assertion", token);
  return app().fetch(new Request(url, { headers: h }), { ...env, ...overrides }, createExecutionContext());
}

async function expectRejected(res: Response, status: 401 | 403) {
  expect(res.status).toBe(status);
  const body = await res.json();
  // No detail: the same generic body for every reason.
  expect(body).toEqual({
    code: status === 401 ? "unauthorized" : "forbidden",
    message: status === 401 ? "Unauthorized." : "Forbidden.",
    correlationId: expect.any(String),
  });
  expect(res.headers.get("www-authenticate")).toBeNull();
}

afterEach(() => vi.restoreAllMocks());

describe("adminAuth: valid tokens", () => {
  it("accepts a user on the allowlist and sets the actor to the email", async () => {
    stubAccessCerts();
    const res = await call(await signJwt(userClaims()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: ADMIN_EMAIL });
  });

  it("compares the email case-insensitively and records it lowercase", async () => {
    stubAccessCerts();
    const res = await call(await signJwt(userClaims({ email: "Admin@Example.COM" })), {
      ADMIN_EMAILS: " other@example.com , ADMIN@example.com ",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: ADMIN_EMAIL });
  });

  it("accepts a single string aud as well as an array", async () => {
    stubAccessCerts();
    expect((await call(await signJwt(userClaims({ aud: AUD })))).status).toBe(200);
    expect((await call(await signJwt(userClaims({ aud: ["another-app", AUD] })))).status).toBe(200);
  });

  it("accepts a listed service token as svc:<client id>", async () => {
    stubAccessCerts();
    const res = await call(await signJwt(serviceClaims()), { ADMIN_SERVICE_CLIENTS: SERVICE_CLIENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: `svc:${SERVICE_CLIENT}` });
  });
});

describe("adminAuth: identity checks (403)", () => {
  it("rejects an email that is not on the allowlist", async () => {
    stubAccessCerts();
    await expectRejected(await call(await signJwt(userClaims({ email: "intruder@example.com" }))), 403);
  });

  it("rejects everyone when the allowlist is empty", async () => {
    stubAccessCerts();
    await expectRejected(await call(await signJwt(userClaims()), { ADMIN_EMAILS: "" }), 403);
  });

  it("rejects a service token that is not listed (the production list is empty)", async () => {
    stubAccessCerts();
    await expectRejected(await call(await signJwt(serviceClaims()), { ADMIN_SERVICE_CLIENTS: "" }), 403);
    await expectRejected(await call(await signJwt(serviceClaims()), { ADMIN_SERVICE_CLIENTS: "other.access" }), 403);
  });

  it("does not let a service-token name in ADMIN_EMAILS or an email in ADMIN_SERVICE_CLIENTS cross over", async () => {
    stubAccessCerts();
    await expectRejected(await call(await signJwt(serviceClaims()), { ADMIN_EMAILS: SERVICE_CLIENT, ADMIN_SERVICE_CLIENTS: "" }), 403);
    await expectRejected(await call(await signJwt(userClaims()), { ADMIN_EMAILS: "", ADMIN_SERVICE_CLIENTS: ADMIN_EMAIL }), 403);
  });

  it("rejects a token with both an email and a common_name, or neither", async () => {
    stubAccessCerts();
    const both = await signJwt(userClaims({ common_name: SERVICE_CLIENT }));
    await expectRejected(await call(both, { ADMIN_SERVICE_CLIENTS: SERVICE_CLIENT }), 403);
    await expectRejected(await call(await signJwt(userClaims({ email: undefined }))), 403);
  });

  it("never reads Cf-Access-Authenticated-User-Email", async () => {
    stubAccessCerts();
    const token = await signJwt(userClaims({ email: "intruder@example.com" }));
    await expectRejected(await call(token, {}, `${ADMIN}/whoami`, { "Cf-Access-Authenticated-User-Email": ADMIN_EMAIL }), 403);
    await expectRejected(await call(null, {}, `${ADMIN}/whoami`, { "Cf-Access-Authenticated-User-Email": ADMIN_EMAIL }), 401);
  });
});

describe("adminAuth: token checks (401)", () => {
  it("rejects a missing or empty header", async () => {
    stubAccessCerts();
    await expectRejected(await call(null), 401);
    await expectRejected(await call(""), 401);
  });

  it("rejects the token in Authorization: Bearer form only", async () => {
    stubAccessCerts();
    const res = await call(null, {}, `${ADMIN}/whoami`, { Authorization: `Bearer ${await signJwt(userClaims())}` });
    await expectRejected(res, 401);
  });

  it("rejects a wrong aud", async () => {
    stubAccessCerts();
    await expectRejected(await call(await signJwt(userClaims({ aud: ["another-app"] }))), 401);
    await expectRejected(await call(await signJwt(userClaims({ aud: undefined }))), 401);
  });

  it("rejects a wrong or missing iss", async () => {
    stubAccessCerts();
    await expectRejected(await call(await signJwt(userClaims({ iss: "https://evil.cloudflareaccess.com" }))), 401);
    await expectRejected(await call(await signJwt(userClaims({ iss: TEAM_DOMAIN }))), 401);
    await expectRejected(await call(await signJwt(userClaims({ iss: undefined }))), 401);
  });

  it("rejects an expired token, a token with no exp, and one not valid yet", async () => {
    stubAccessCerts();
    const now = Math.floor(Date.now() / 1000);
    await expectRejected(await call(await signJwt(userClaims({ exp: now - 1 }))), 401);
    await expectRejected(await call(await signJwt(userClaims({ exp: undefined }))), 401);
    await expectRejected(await call(await signJwt(userClaims({ nbf: now + 600 }))), 401);
  });

  it("rejects an unsigned token and alg:none", async () => {
    stubAccessCerts();
    const good = await signJwt(userClaims());
    const [header, payload] = good.split(".");
    await expectRejected(await call(`${header}.${payload}.`), 401);
    await expectRejected(await call(`${header}.${payload}`), 401);
    const none = btoa(JSON.stringify({ alg: "none", typ: "JWT", kid: "access-key-1" })).replace(/=+$/, "");
    await expectRejected(await call(`${none}.${payload}.`), 401);
  });

  it("rejects HS256 (a symmetric alg signed with a guessable key)", async () => {
    stubAccessCerts();
    const { sign } = await import("hono/utils/jwt/jwt");
    await expectRejected(await call(await sign(userClaims(), "secret", "HS256")), 401);
  });

  it("rejects a token signed by another key with the same kid", async () => {
    stubAccessCerts();
    await expectRejected(await call(await signJwt(userClaims(), otherKey.privateJwk)), 401);
  });

  it("rejects a token whose kid is not published", async () => {
    stubAccessCerts();
    await expectRejected(await call(await signJwt(userClaims(), { ...otherKey.privateJwk, kid: "unknown" })), 401);
  });

  it("rejects a tampered payload", async () => {
    stubAccessCerts();
    const [header, , signature] = (await signJwt(userClaims({ email: "intruder@example.com" }))).split(".");
    const payload = btoa(JSON.stringify(userClaims())).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    await expectRejected(await call(`${header}.${payload}.${signature}`), 401);
  });

  it("fails closed when Access is not configured", async () => {
    const fetchSpy = stubAccessCerts();
    const token = await signJwt(userClaims());
    await expectRejected(await call(token, { ACCESS_TEAM_DOMAIN: "" }), 401);
    await expectRejected(await call(token, { ACCESS_AUD: "" }), 401);
    await expectRejected(await call(token, { ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com" }), 401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed (401) when the certs endpoint is down", async () => {
    stubAccessCerts();
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("down", { status: 503 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expectRejected(await call(await signJwt(userClaims())), 401);
  });
});

describe("adminAuth: key cache", () => {
  it("fetches the certs once and reuses them", async () => {
    const fetchSpy = stubAccessCerts();
    for (let i = 0; i < 3; i++) expect((await call(await signJwt(userClaims()))).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Request(fetchSpy.mock.calls[0]![0]).url).toBe(CERTS_URL);
  });

  it("refetches once for an unknown kid (key rotation), but not for every bad token", async () => {
    const fetchSpy = stubAccessCerts([]);
    // Cold cache with no keys, then Access rotates in a new key.
    await expectRejected(await call(await signJwt(userClaims())), 401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({ keys: [(await import("../test/access")).accessKey.publicJwk] }));
    // Within the refetch interval a miss does not refetch (no amplification from forged kids).
    await expectRejected(await call(await signJwt(userClaims())), 401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    try {
      expect((await call(await signJwt(userClaims()))).status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("adminAuth: DEV_AUTH", () => {
  it("injects the fixed dev actor on a *.localhost host when DEV_AUTH=1", async () => {
    const fetchSpy = stubAccessCerts();
    const res = await call(null, { DEV_AUTH: "1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: DEV_ACTOR });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is ignored when unset or set to anything but 1", async () => {
    stubAccessCerts();
    await expectRejected(await call(null, {}), 401);
    for (const value of ["", "0", "true", "yes", " 1"]) await expectRejected(await call(null, { DEV_AUTH: value }), 401);
  });

  it("is ignored on a host that is not *.localhost", async () => {
    stubAccessCerts();
    for (const host of ["admin.example.com", "admin.localhost.example.com", "localhost.evil.com", "admin.localhosts"]) {
      await expectRejected(await call(null, { DEV_AUTH: "1", ADMIN_HOST: host }, `https://${host}/whoami`), 401);
    }
  });
});
