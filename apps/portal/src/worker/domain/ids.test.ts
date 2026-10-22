import { describe, expect, it } from "vitest";
import {
  newDeviceCredential,
  newEnrolCode,
  newId,
  newPublicId,
  newShareToken,
  normaliseEnrolCode,
} from "./ids";
import { hashToken, timingSafeEqual } from "./tokens";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function distinct(make: () => string, n = 200): number {
  return new Set(Array.from({ length: n }, make)).size;
}

describe("newId (UUIDv7)", () => {
  it("is a version-7, variant-1 UUID", () => {
    expect(newId()).toMatch(UUID_V7);
  });

  it("carries the millisecond timestamp in its first 48 bits", () => {
    const at = new Date("2026-10-22T09:30:00.123Z");
    const hex = newId(at).replace(/-/g, "").slice(0, 12);
    expect(parseInt(hex, 16)).toBe(at.getTime());
  });

  it("sorts by creation time as text", () => {
    const earlier = newId(new Date("2026-01-01T00:00:00.000Z"));
    const later = newId(new Date("2026-01-01T00:00:00.001Z"));
    expect(earlier < later).toBe(true);
  });

  it("is unique within the same millisecond", () => {
    const at = new Date();
    expect(distinct(() => newId(at))).toBe(200);
  });
});

describe("secrets and public identifiers", () => {
  it("public_id is 16 lowercase base32 characters (80 bits)", () => {
    expect(newPublicId()).toMatch(/^[a-z2-7]{16}$/);
    expect(distinct(newPublicId)).toBe(200);
  });

  it("share token is 22 base64url characters (128 bits)", () => {
    expect(newShareToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(distinct(newShareToken)).toBe(200);
  });

  it("device credential is 43 base64url characters (256 bits)", () => {
    expect(newDeviceCredential()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(distinct(newDeviceCredential)).toBe(200);
  });

  it("enrolment code is 8 Crockford base32 characters (40 bits)", () => {
    expect(newEnrolCode()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    expect(distinct(newEnrolCode)).toBe(200);
  });

  it("uses every alphabet character (no modulo bias that drops some)", () => {
    const seen = new Set(Array.from({ length: 400 }, newEnrolCode).join(""));
    expect(seen.size).toBe(32);
  });
});

describe("normaliseEnrolCode", () => {
  it("accepts what an operator might type", () => {
    expect(normaliseEnrolCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normaliseEnrolCode(" 7k3m 9q2z ")).toBe("7K3M9Q2Z");
  });

  it("maps the Crockford look-alikes I, L and O", () => {
    expect(normaliseEnrolCode("iLo0OOOO")).toBe("11000000");
  });

  it("returns null for anything that cannot be a code", () => {
    expect(normaliseEnrolCode("")).toBeNull();
    expect(normaliseEnrolCode("ABCDEFG")).toBeNull();
    expect(normaliseEnrolCode("ABCDEFGHJ")).toBeNull();
    expect(normaliseEnrolCode("ABCDEFGU")).toBeNull();
    expect(normaliseEnrolCode("ABCD_EFG")).toBeNull();
  });
});

describe("hashToken", () => {
  it("is the SHA-256 hex digest", async () => {
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("timingSafeEqual", () => {
  it("compares strings", () => {
    expect(timingSafeEqual("same-token", "same-token")).toBe(true);
    expect(timingSafeEqual("same-token", "same-tokem")).toBe(false);
  });

  it("is false for different lengths, including a prefix", () => {
    expect(timingSafeEqual("token", "token-longer")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });

  it("compares UTF-8 bytes, not UTF-16 units", () => {
    expect(timingSafeEqual("é", "é")).toBe(true);
    expect(timingSafeEqual("é", "é")).toBe(false);
  });
});
