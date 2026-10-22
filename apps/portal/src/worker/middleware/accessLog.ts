import { createMiddleware } from "hono/factory";
import { log } from "../lib/log";
import { VERSION } from "../lib/version";
import type { AppEnv } from "../types";

/** One log line per request: method, path (no query), status, duration. Never headers or bodies. */
export const accessLog = (host: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const start = Date.now();
    await next();
    log.info({
      requestId: c.get("requestId"),
      version: VERSION,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - start,
      host,
      outcome: c.res.status >= 500 ? "server_error" : c.res.status >= 400 ? "client_error" : "ok",
    });
  });
