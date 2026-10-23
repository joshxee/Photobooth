import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { signJwt, stubAccessCerts, userClaims } from "./test/access";

const GALLERY = "http://photos.localhost:8787";
const ADMIN = "http://admin.localhost:8787";

// A stand-in for the assets binding, so these tests don't depend on a prior `bun run build`.
// Real build output is checked through `wrangler dev` (see wiki/Portal.md).
const FILES: Record<string, { type: string; body: string }> = {
  "/gallery/index.html": { type: "text/html", body: "<!doctype html><title>Gallery</title>" },
  "/gallery/assets/main-abc123.js": { type: "text/javascript", body: "console.log('gallery')" },
  "/admin/index.html": { type: "text/html", body: "<!doctype html><title>Admin</title>" },
  "/admin/assets/main-def456.js": { type: "text/javascript", body: "console.log('admin')" },
};

const requested: string[] = [];
const assets = {
  async fetch(input: RequestInfo | URL) {
    const url = new URL(new Request(input).url);
    requested.push(url.pathname + url.search);
    const file = FILES[url.pathname];
    if (!file) return new Response("not found", { status: 404 });
    return new Response(file.body, { headers: { "Content-Type": file.type, ETag: '"x"' } });
  },
} as unknown as Fetcher;

async function get(url: string, headers: HeadersInit = {}) {
  requested.length = 0;
  const app = createApp();
  return app.fetch(new Request(url, { headers }), { ...env, ASSETS: assets }, createExecutionContext());
}

describe("gallery SPA", () => {
  it("serves the HTML shell for /e/*, with security headers", async () => {
    for (const path of ["/e/abc123", "/e/abc123/", "/e/abc123/photo/5"]) {
      const res = await get(`${GALLERY}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Gallery</title>");
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    }
  });

  it("never answers for the guest API or media paths: those are JSON 404s, not the shell", async () => {
    for (const path of ["/e/abcdefghijklmnop/api/other", "/e/abcdefghijklmnop/api/", "/e/abcdefghijklmnop/m/x", "/e/abcdefghijklmnop/m/"]) {
      const res = await get(`${GALLERY}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toMatch(/^application\/json/);
    }
    expect(requested).toEqual([]);
  });

  it("does not forward the query string (it can carry the share token) to the assets binding", async () => {
    await get(`${GALLERY}/e/abc123?t=SECRET`);
    expect(requested).toEqual(["/gallery/index.html"]);
  });

  it("serves hashed bundles from /assets/ as immutable", async () => {
    const res = await get(`${GALLERY}/assets/main-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does not serve the admin bundle", async () => {
    expect((await get(`${GALLERY}/assets/main-def456.js`)).status).toBe(404);
  });

  it("404s on a missing asset in the error shape", async () => {
    const res = await get(`${GALLERY}/assets/missing.js`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("does not expose the raw SPA directories or index.html", async () => {
    expect((await get(`${GALLERY}/gallery/index.html`)).status).toBe(404);
    expect((await get(`${GALLERY}/index.html`)).status).toBe(404);
  });
});

describe("admin SPA", () => {
  // The admin host authenticates every request, the shell and bundles included.
  const getAdmin = async (url: string) => get(url, { "Cf-Access-Jwt-Assertion": await signJwt(userClaims()) });
  beforeEach(() => {
    stubAccessCerts();
  });
  afterEach(() => vi.restoreAllMocks());

  it("needs the Access JWT for the shell and the bundles", async () => {
    expect((await get(`${ADMIN}/`)).status).toBe(401);
    expect((await get(`${ADMIN}/assets/main-def456.js`)).status).toBe(401);
    expect(requested).toEqual([]);
  });

  it("serves the HTML shell for /", async () => {
    const res = await getAdmin(`${ADMIN}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Admin</title>");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("serves the shell for the SPA's own views, so a reload or a bookmark works", async () => {
    for (const path of ["/events", "/events/new", "/events/019a0b7e-0000-7000-8000-000000000001", "/events/019a0b7e-0000-7000-8000-000000000001/edit", "/devices", "/audit"]) {
      const res = await getAdmin(`${ADMIN}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain("<title>Admin</title>");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("answers anything else, and unknown API paths, with a JSON 404 rather than the shell", async () => {
    for (const path of ["/elsewhere", "/events/new/x", "/devices/x", "/api/nope", "/api/events/x/y/z"]) {
      const res = await getAdmin(`${ADMIN}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("serves the shell on GET only", async () => {
    const headers = { "Cf-Access-Jwt-Assertion": await signJwt(userClaims()), Origin: ADMIN, "Content-Type": "application/json" };
    const res = await createApp().fetch(new Request(`${ADMIN}/devices`, { method: "POST", headers, body: "{}" }), { ...env, ASSETS: assets }, createExecutionContext());
    expect(res.status).toBe(404);
  });

  it("serves hashed bundles from /assets/ as immutable, and not the gallery's", async () => {
    const ok = await getAdmin(`${ADMIN}/assets/main-def456.js`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await getAdmin(`${ADMIN}/assets/main-abc123.js`)).status).toBe(404);
  });

  it("does not serve the gallery shell", async () => {
    expect((await getAdmin(`${ADMIN}/e/abc123`)).status).toBe(404);
  });
});
