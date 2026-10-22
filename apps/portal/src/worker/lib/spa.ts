import type { Handler } from "hono";
import type { AppEnv, PortalApp } from "../types";

export type Spa = "gallery" | "admin";

// build.ts writes dist/<spa>/index.html and dist/<spa>/assets/<name>-<hash>.<ext>. Both SPAs live
// in one assets directory, so the host decides which sub-directory a path maps to.

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Serves the SPA's HTML shell. Never cached long: it names the current hashed bundles. */
export const serveSpa =
  (spa: Spa): Handler<AppEnv> =>
  async (c) => {
    const url = new URL(c.req.url);
    url.pathname = `/${spa}/index.html`;
    url.search = "";
    const res = await c.env.ASSETS.fetch(new Request(url, { method: "GET" }));
    if (!res.ok) return c.notFound();
    return new Response(res.body, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
  };

/** Hashed bundles under /assets/. Anything else under /assets/ that isn't a file is a 404. */
export function serveSpaAssets(app: PortalApp, spa: Spa): void {
  app.get("/assets/*", async (c) => {
    const url = new URL(c.req.url);
    url.pathname = `/${spa}${url.pathname}`;
    url.search = "";
    const res = await c.env.ASSETS.fetch(new Request(url, { method: "GET" }));
    if (!res.ok) return c.notFound();
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", IMMUTABLE);
    return new Response(res.body, { status: 200, headers });
  });
}
