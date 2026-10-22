import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { AppEnv } from "../types";
import { log } from "./log";

/** The error body every API and page returns (DESIGN §8). */
export interface ErrorBody {
  code: string;
  message: string;
  correlationId: string;
}

/** Throw this from a route to return a specific status, code and (safe to show) message. */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

function respond(c: Context<AppEnv>, status: number, code: string, message: string): Response {
  const body: ErrorBody = { code, message, correlationId: c.get("requestId") };
  return c.json(body, status as 400);
}

/** zod errors become 400, unknown errors 500; neither leaks the underlying message or issues. */
export const handleError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof AppError) return respond(c, err.status, err.code, err.message);
  if (err instanceof ZodError) return respond(c, 400, "invalid_request", "The request was not valid.");
  if (err instanceof HTTPException) return respond(c, err.status, "http_error", "The request could not be processed.");
  log.error({
    requestId: c.get("requestId"),
    outcome: "internal_error",
    errorName: err instanceof Error ? err.name : typeof err,
  });
  return respond(c, 500, "internal_error", "Something went wrong.");
};

export const handleNotFound: NotFoundHandler<AppEnv> = (c) => respond(c, 404, "not_found", "Not found.");
