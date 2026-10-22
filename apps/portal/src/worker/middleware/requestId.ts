import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";

/**
 * Gives every request a fresh ID, exposed as `X-Request-Id` and used as the error `correlationId`.
 * A caller-supplied ID is deliberately ignored, so it can't be used to inject log content.
 */
export const requestId = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const id = crypto.randomUUID();
    c.set("requestId", id);
    await next();
    c.res.headers.set("X-Request-Id", id);
  });
