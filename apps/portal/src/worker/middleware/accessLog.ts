import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { type LogFields, log } from "../lib/log";
import { VERSION } from "../lib/version";
import type { AppEnv } from "../types";

/** Adds IDs (device, event, photo) to this request's access log line. */
export function addLogIds(c: Context<AppEnv>, ids: Pick<LogFields, "deviceId" | "eventId" | "photoId">): void {
  c.set("logIds", { ...c.get("logIds"), ...ids });
}

/** Adds D1 rows read to this request's access log line (summed over the request's queries). */
export function addRowsRead(c: Context<AppEnv>, rows: number): void {
  const logIds = c.get("logIds");
  c.set("logIds", { ...logIds, rowsRead: (logIds?.rowsRead ?? 0) + rows });
}

/**
 * One log line per request: method, path (no query), status, duration, and the IDs a route added.
 * Never headers or bodies.
 */
export const accessLog = (host: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const start = Date.now();
    await next();
    log.info({
      requestId: c.get("requestId"),
      ...c.get("logIds"),
      version: VERSION,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - start,
      host,
      outcome: c.res.status >= 500 ? "server_error" : c.res.status >= 400 ? "client_error" : "ok",
    });
  });
