import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./log";

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger((line) => lines.push(line)) };
}

afterEach(() => vi.restoreAllMocks());

describe("logger", () => {
  it("sends each level to the matching console method", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger();
    logger.info({ outcome: "a" });
    logger.warn({ outcome: "b" });
    logger.error({ outcome: "c" });
    expect([log.mock.calls.length, warn.mock.calls.length, error.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it("writes one JSON object per line with level and timestamp", () => {
    const { lines, log } = capture();
    log.info({ requestId: "r1", eventId: "e1", photoId: "p1", deviceId: "d1", outcome: "ok" });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string);
    expect(entry).toMatchObject({
      level: "info",
      requestId: "r1",
      eventId: "e1",
      photoId: "p1",
      deviceId: "d1",
      outcome: "ok",
    });
    expect(typeof entry.ts).toBe("string");
  });

  it("strips the query string and fragment from path", () => {
    const { lines, log } = capture();
    log.info({ path: "/e/abc/api/session?token=SECRET-TOKEN#frag" });
    expect(lines[0]).not.toContain("SECRET-TOKEN");
    expect(JSON.parse(lines[0] as string).path).toBe("/e/abc/api/session");
  });

  it("drops fields that are not on the allowlist (cookies, auth headers, bodies, queries)", () => {
    const { lines, log } = capture();
    log.info({
      requestId: "r1",
      cookie: "portal_session=SECRET-COOKIE",
      authorization: "Bearer SECRET-BEARER",
      body: '{"token":"SECRET-BODY"}',
      query: "?t=SECRET-QUERY",
      headers: { "cf-access-jwt-assertion": "SECRET-JWT" },
    } as never);
    const entry = JSON.parse(lines[0] as string);
    expect(Object.keys(entry).sort()).toEqual(["level", "requestId", "ts"]);
    for (const secret of ["SECRET-COOKIE", "SECRET-BEARER", "SECRET-BODY", "SECRET-QUERY", "SECRET-JWT"]) {
      expect(lines[0]).not.toContain(secret);
    }
  });

  it("supports warn and error levels", () => {
    const { lines, log } = capture();
    log.warn({ outcome: "slow" });
    log.error({ outcome: "failed", errorName: "TypeError" });
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(["warn", "error"]);
  });
});
