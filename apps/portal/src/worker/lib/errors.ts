import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { ERROR_STATUS, type ErrorBody, type ErrorCode } from "../../shared/schemas";
import type { AppEnv } from "../types";
import { log } from "./log";

/**
 * Throw this from a route to return a specific code and (safe to show) message. The status
 * comes from the code (ERROR_STATUS), so a code always travels with the same status.
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
    this.status = ERROR_STATUS[code];
  }
}

function respond(c: Context<AppEnv>, code: ErrorCode, message: string): Response {
  const body: ErrorBody = { code, message, correlationId: c.get("requestId") };
  return c.json(body, ERROR_STATUS[code]);
}

/** Hono middleware throws HTTPException (body limit, JWT); map its status onto the closed code set. */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 413:
      return "too_large";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "internal" : "invalid_request";
  }
}

/** zod errors become 400, unknown errors 500; neither leaks the underlying message or issues. */
export const handleError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof AppError) return respond(c, err.code, err.message);
  if (err instanceof ZodError) return respond(c, "invalid_request", "The request was not valid.");
  if (err instanceof HTTPException) return respond(c, codeForStatus(err.status), "The request could not be processed.");
  log.error({
    requestId: c.get("requestId"),
    outcome: "internal_error",
    errorName: err instanceof Error ? err.name : typeof err,
  });
  return respond(c, "internal", "Something went wrong.");
};

export const handleNotFound: NotFoundHandler<AppEnv> = (c) => respond(c, "not_found", "Not found.");
