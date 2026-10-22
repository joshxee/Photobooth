import { createMiddleware } from "hono/factory";
import { AppError } from "../lib/errors";
import { originOf } from "../lib/hosts";
import type { AppEnv } from "../types";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * CSRF guard for the admin host (DESIGN §13). Every request that isn't GET/HEAD must come from
 * the admin origin itself and be `application/json`. A cross-site form or `fetch` can't set both:
 * browsers always send `Origin` on such requests, and a JSON content type from another origin
 * needs a CORS preflight, which this Worker never answers (no CORS headers anywhere).
 * The origin is `https://<ADMIN_HOST>`, or `http://` for a local `*.localhost` host.
 */
export const sameOrigin = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("Origin");
    const mediaType = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (origin !== originOf(c.env.ADMIN_HOST) || mediaType !== "application/json") {
      throw new AppError("forbidden", "Forbidden.");
    }
    return next();
  });
