import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createHostApp } from "../lib/hostApp";
import { sameOrigin } from "./sameOrigin";

const ADMIN = "http://admin.localhost:8787";

function call(method: string, headers: Record<string, string>, overrides: Partial<Env> = {}, url = `${ADMIN}/x`) {
  const app = createHostApp("admin");
  app.use(sameOrigin());
  app.on(["GET", "POST", "PATCH", "PUT", "DELETE"], "/x", (c) => c.json({ ok: true }));
  const body = method === "GET" ? undefined : "{}";
  return app.fetch(new Request(url, { method, headers, body }), { ...env, ...overrides }, createExecutionContext());
}

const JSON_SAME = { Origin: "http://admin.localhost:8787", "Content-Type": "application/json" };

describe("sameOrigin", () => {
  it("lets GET through with no Origin or content type", async () => {
    expect((await call("GET", {})).status).toBe(200);
    expect((await call("GET", { Origin: "https://evil.example.com" })).status).toBe(200);
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])("allows a same-origin JSON %s", async (method) => {
    expect((await call(method, JSON_SAME)).status).toBe(200);
  });

  it("accepts a charset parameter and any case on the media type", async () => {
    expect((await call("POST", { ...JSON_SAME, "Content-Type": "Application/JSON; charset=utf-8" })).status).toBe(200);
  });

  it.each([
    ["a cross-origin POST", { ...JSON_SAME, Origin: "https://evil.example.com" }],
    ["no Origin", { "Content-Type": "application/json" }],
    ["Origin: null", { ...JSON_SAME, Origin: "null" }],
    ["the gallery host's origin", { ...JSON_SAME, Origin: "http://photos.localhost:8787" }],
    ["a different port", { ...JSON_SAME, Origin: "http://admin.localhost:9999" }],
    ["https for a local host", { ...JSON_SAME, Origin: "https://admin.localhost:8787" }],
    ["a form post", { Origin: JSON_SAME.Origin, "Content-Type": "application/x-www-form-urlencoded" }],
    ["text/plain", { Origin: JSON_SAME.Origin, "Content-Type": "text/plain" }],
    ["a json look-alike", { Origin: JSON_SAME.Origin, "Content-Type": "application/jsonx" }],
    ["no content type", { Origin: JSON_SAME.Origin }],
  ])("returns 403 for %s", async (_name, headers) => {
    const res = await call("POST", headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("requires https on a real host, and http there is refused", async () => {
    const real = { ADMIN_HOST: "admin.example.com" };
    const url = "https://admin.example.com/x";
    expect((await call("POST", { ...JSON_SAME, Origin: "https://admin.example.com" }, real, url)).status).toBe(200);
    expect((await call("POST", { ...JSON_SAME, Origin: "http://admin.example.com" }, real, url)).status).toBe(403);
  });

  it("sets no CORS headers, even on a preflight", async () => {
    const res = await call("OPTIONS", { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
  });
});
