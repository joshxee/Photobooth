import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorBody } from "../../shared/schemas";
import { requestId } from "../middleware/requestId";
import type { AppEnv } from "../types";
import { AppError, handleError, handleNotFound } from "./errors";

function appThatThrows(error: unknown) {
  const app = new Hono<AppEnv>();
  app.use(requestId());
  app.onError(handleError);
  app.notFound(handleNotFound);
  app.get("/boom", () => {
    throw error;
  });
  return app;
}

async function body(res: Response) {
  return (await res.json()) as { code: string; message: string; correlationId: string };
}

describe("error mapping", () => {
  it("maps a zod error to 400 without echoing the issues", async () => {
    const parsed = z.object({ secretField: z.string() }).safeParse({ secretField: 42 });
    if (parsed.success) throw new Error("expected a zod failure");
    const res = await appThatThrows(parsed.error).request("/boom");
    expect(res.status).toBe(400);
    const json = await body(res);
    expect(json.code).toBe("invalid_request");
    expect(JSON.stringify(json)).not.toContain("secretField");
  });

  it("maps an unknown error to a generic 500 that leaks nothing", async () => {
    const res = await appThatThrows(new Error("db password is hunter2")).request("/boom");
    expect(res.status).toBe(500);
    const json = await body(res);
    expect(json.code).toBe("internal");
    expect(JSON.stringify(json)).not.toContain("hunter2");
  });

  it("uses the code and message of an AppError, with the code's status", async () => {
    const res = await appThatThrows(new AppError("photo_limit", "Event is full")).request("/boom");
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: "photo_limit", message: "Event is full" });
  });

  it("gives every code its one status", async () => {
    for (const [code, status] of [["too_large", 413], ["upload_expired", 410], ["hash_mismatch", 422], ["rate_limited", 429]] as const) {
      expect((await appThatThrows(new AppError(code, "x")).request("/boom")).status).toBe(status);
    }
  });

  it.each([
    [400, 400, "invalid_request"],
    [401, 401, "unauthorized"],
    [403, 403, "forbidden"],
    [404, 404, "not_found"],
    [413, 413, "too_large"],
    [429, 429, "rate_limited"],
    [405, 400, "invalid_request"],
    [503, 500, "internal"],
  ] as const)("maps a Hono HTTPException %i to %i %s with a generic message", async (thrown, status, code) => {
    const res = await appThatThrows(new HTTPException(thrown, { message: "internal detail" })).request("/boom");
    expect(res.status).toBe(status);
    const json = await body(res);
    expect(json.code).toBe(code);
    expect(JSON.stringify(json)).not.toContain("internal detail");
  });

  it("every error body matches the contract's ErrorBody", async () => {
    for (const error of [new Error("x"), new AppError("conflict", "x"), new HTTPException(401)]) {
      const res = await appThatThrows(error).request("/boom");
      expect(ErrorBody.safeParse(await res.json()).success).toBe(true);
    }
    expect(ErrorBody.safeParse(await (await appThatThrows(new Error()).request("/nope")).json()).success).toBe(true);
  });

  it("returns the not_found shape for unmatched routes", async () => {
    const res = await appThatThrows(new Error("unused")).request("/nope");
    expect(res.status).toBe(404);
    expect(await body(res)).toMatchObject({ code: "not_found" });
  });

  it("uses the request ID as the correlation ID, in the body and the header", async () => {
    const res = await appThatThrows(new Error("x")).request("/boom");
    const json = await body(res);
    expect(json.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("x-request-id")).toBe(json.correlationId);
  });
});
