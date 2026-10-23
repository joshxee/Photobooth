import { describe, expect, it } from "vitest";
import pendingFixture from "../../../contract/fixtures/device.intent-response.pending-hd.json";
import { UploadDescriptor } from "../../shared/schemas";
import { expectFixtureShape } from "../test/device";
import { hmacUploadSigner, UPLOAD_URL_TTL_SECONDS, type UploadTarget, verifyUploadUrl } from "./uploadUrl";

const KEY = "test-upload-key-0123456789abcdef0123456789abcdef";
const ORIGIN = "https://photos.example.test";
const NOW = new Date("2026-10-22T09:30:00.000Z");
const target: UploadTarget = {
  photoId: "019a0b7e-8c21-7d05-a3f6-0e1f2a3b4c5d",
  variant: "hd",
  bytes: 416_204,
  sha256: "2c71895fa8203ccefdb64c5c05f6c6d7b9394913c2ac32004c4717a984d151e8",
};

async function signedQuery(t: UploadTarget = target, key = KEY, now = NOW) {
  const descriptor = await hmacUploadSigner(key, ORIGIN).sign(t, now);
  const url = new URL(descriptor.url);
  return { descriptor, url, exp: url.searchParams.get("exp") ?? undefined, sig: url.searchParams.get("sig") ?? undefined };
}

describe("hmacUploadSigner", () => {
  it("builds the contract's descriptor: PUT, the upload path, Content-Type, expiry in 15 minutes", async () => {
    const { descriptor, url } = await signedQuery();
    expect(UploadDescriptor.parse(descriptor)).toEqual(descriptor);
    expectFixtureShape(descriptor, pendingFixture.uploads.hd);
    expect(descriptor.method).toBe("PUT");
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(`/v1/device/uploads/${target.photoId}/hd`);
    expect([...url.searchParams.keys()]).toEqual(["exp", "sig"]);
    expect(descriptor.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(UPLOAD_URL_TTL_SECONDS).toBe(15 * 60);
    expect(descriptor.expiresAt).toBe("2026-10-22T09:45:00.000Z");
    expect(url.searchParams.get("exp")).toBe(String(Date.parse("2026-10-22T09:45:00.000Z") / 1000));
    expect(url.searchParams.get("sig")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a missing or short key (fail closed)", async () => {
    await expect(hmacUploadSigner("", ORIGIN).sign(target, NOW)).rejects.toThrow(/UPLOAD_KEY/);
    await expect(hmacUploadSigner("short", ORIGIN).sign(target, NOW)).rejects.toThrow(/UPLOAD_KEY/);
  });
});

describe("verifyUploadUrl", () => {
  it("accepts its own URL until it expires", async () => {
    const { exp, sig } = await signedQuery();
    expect(await verifyUploadUrl(KEY, target, { exp, sig }, NOW)).toBe("valid");
    expect(await verifyUploadUrl(KEY, target, { exp, sig }, new Date(NOW.getTime() + 15 * 60_000 - 1))).toBe("valid");
  });

  it("is expired at and after the expiry", async () => {
    const { exp, sig } = await signedQuery();
    expect(await verifyUploadUrl(KEY, target, { exp, sig }, new Date(NOW.getTime() + 15 * 60_000))).toBe("expired");
    expect(await verifyUploadUrl(KEY, target, { exp, sig }, new Date(NOW.getTime() + 60 * 60_000))).toBe("expired");
  });

  it("is invalid for another photo, variant, size or hash (the signature binds them all)", async () => {
    const { exp, sig } = await signedQuery();
    const verify = (t: Partial<UploadTarget>) => verifyUploadUrl(KEY, { ...target, ...t }, { exp, sig }, NOW);
    expect(await verify({ photoId: "019a0b7e-8c21-7d05-a3f6-0e1f2a3b4c5e" })).toBe("invalid");
    expect(await verify({ variant: "thumb" })).toBe("invalid");
    expect(await verify({ bytes: target.bytes + 1 })).toBe("invalid");
    expect(await verify({ sha256: "0".repeat(64) })).toBe("invalid");
  });

  it("is invalid with a tampered expiry, even an expired one (the signature is checked first)", async () => {
    const { exp, sig } = await signedQuery();
    const later = String(Number(exp) + 3600);
    expect(await verifyUploadUrl(KEY, target, { exp: later, sig }, NOW)).toBe("invalid");
    const earlier = String(Number(exp) - 3600);
    expect(await verifyUploadUrl(KEY, target, { exp: earlier, sig }, NOW)).toBe("invalid");
  });

  it("is invalid with a tampered, missing or malformed signature or expiry, or another key", async () => {
    const { exp, sig } = await signedQuery();
    const flipped = (sig![0] === "A" ? "B" : "A") + sig!.slice(1);
    for (const query of [
      { exp, sig: flipped },
      { exp, sig: undefined },
      { exp: undefined, sig },
      { exp, sig: `${sig}=` },
      { exp, sig: sig!.slice(1) },
      { exp: `${exp}.0`, sig },
      { exp: `0${exp}`, sig },
      { exp: "-1", sig },
      { exp: "", sig: "" },
    ]) {
      expect(await verifyUploadUrl(KEY, target, query, NOW)).toBe("invalid");
    }
    expect(await verifyUploadUrl(`${KEY}x`, target, { exp, sig }, NOW)).toBe("invalid");
  });
});
