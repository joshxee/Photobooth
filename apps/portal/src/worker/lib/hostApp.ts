import { Hono } from "hono";
import { accessLog } from "../middleware/accessLog";
import { securityHeaders } from "../middleware/headers";
import { requestId } from "../middleware/requestId";
import type { AppEnv, PortalApp } from "../types";
import { handleError, handleNotFound } from "./errors";
import { VERSION } from "./version";

export type HostKind = "gallery" | "admin" | "unknown";

/**
 * A Hono app with the cross-cutting stack every host needs: request ID, security headers, access
 * log, and the error shapes. The gallery, admin and unknown-host apps are all built from this, so
 * no response, error and 404 included, can skip the headers.
 */
export function createHostApp(kind: HostKind): PortalApp {
  const app = new Hono<AppEnv>();
  app.use(requestId());
  app.use(securityHeaders());
  app.use(accessLog(kind));
  app.onError(handleError);
  app.notFound(handleNotFound);
  return app;
}

/** `GET /healthz` on both real hosts. Deliberately not registered for unknown hosts. */
export function addHealthz(app: PortalApp): void {
  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, version: VERSION });
  });
}
