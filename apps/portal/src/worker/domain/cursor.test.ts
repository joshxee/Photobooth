import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

const position = { publishedAt: "2026-10-22T09:30:00.123Z", id: "019a0b6c-1d2e-7f00-8a00-0123456789ab" };

describe("cursor", () => {
  it("round-trips a position", () => {
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it("is URL-safe and opaque", () => {
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(position.id);
  });

  it.each([
    ["empty", ""],
    ["not base64url", "!!!"],
    ["no separator", btoa("2026-10-22T09:30:00.123Z").replace(/=+$/, "")],
    ["bad date", encodeRaw("2026-13-40T99:99:99.999Z|019a0b6c-1d2e-7f00-8a00-0123456789ab")],
    ["date not in toISOString form", encodeRaw("2026-10-22 09:30:00|019a0b6c-1d2e-7f00-8a00-0123456789ab")],
    ["bad id", encodeRaw("2026-10-22T09:30:00.123Z|not-a-uuid")],
    ["extra part", encodeRaw("2026-10-22T09:30:00.123Z|019a0b6c-1d2e-7f00-8a00-0123456789ab|x")],
    ["too long", "A".repeat(200)],
  ])("rejects %s", (_name, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});

function encodeRaw(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
