// Shared pieces of the JSON APIs (admin, device): body parsing and caching.
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import type { AppEnv } from "../types";
import { AppError } from "./errors";

/** The JSON body parsed with `schema`: 400 `invalid_request` if it isn't JSON or doesn't match. */
export async function readBody<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError("invalid_request", "The body must be JSON.");
  }
  return schema.parse(body);
}

/** API responses (errors included) are never cached by the browser or anything in between. */
export const noStore = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
