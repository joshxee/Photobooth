import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "./headers";

describe("securityHeaders", () => {
  it("sets the DESIGN §13 headers", async () => {
    const app = new Hono();
    app.use(securityHeaders());
    app.get("/", (c) => c.text("hi"));
    const res = await app.request("/");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'",
    );
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("works on responses whose headers are immutable", async () => {
    const app = new Hono();
    app.use(securityHeaders());
    app.get("/", () => Response.redirect("http://example.com/elsewhere", 302));
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
