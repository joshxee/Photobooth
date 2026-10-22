import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
    expect(json.code).toBe("internal_error");
    expect(JSON.stringify(json)).not.toContain("hunter2");
  });

  it("uses the status, code and message of an AppError", async () => {
    const res = await appThatThrows(new AppError(409, "conflict", "Already exists")).request("/boom");
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: "conflict", message: "Already exists" });
  });

  it("maps a Hono HTTPException to its status with a generic message", async () => {
    const res = await appThatThrows(new HTTPException(413, { message: "internal detail" })).request("/boom");
    expect(res.status).toBe(413);
    const json = await body(res);
    expect(json.code).toBe("http_error");
    expect(JSON.stringify(json)).not.toContain("internal detail");
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
