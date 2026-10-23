import { describe, expect, it } from "vitest";
import { clearGuestCookie, GUEST_COOKIE_MAX_AGE_SECONDS, guestCookie, signGuestCookie, verifyGuestCookie } from "./guestCookie";

const KEY = "test-session-key-not-a-secret-0123456789abcdef";
const EVENT = "019a0b7e-0000-7000-8000-000000000001";
const NOW = new Date("2026-10-22T09:00:00.000Z");
const grant = { eventId: EVENT, accessVersion: 3 };

describe("guest cookie value", () => {
  it("round-trips the event and access version until it expires 30 days later", async () => {
    const value = await signGuestCookie(KEY, grant, NOW);
    expect(await verifyGuestCookie(KEY, value, NOW)).toEqual(grant);
    const almost = new Date(NOW.getTime() + GUEST_COOKIE_MAX_AGE_SECONDS * 1000 - 1);
    expect(await verifyGuestCookie(KEY, value, almost)).toEqual(grant);
    const expired = new Date(NOW.getTime() + GUEST_COOKIE_MAX_AGE_SECONDS * 1000);
    expect(await verifyGuestCookie(KEY, value, expired)).toBeNull();
    expect(GUEST_COOKIE_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("is eventId.accessVersion.exp.signature, with only cookie-safe characters", async () => {
    const value = await signGuestCookie(KEY, grant, NOW);
    const exp = NOW.getTime() / 1000 + GUEST_COOKIE_MAX_AGE_SECONDS;
    expect(value).toMatch(new RegExp(`^${EVENT}\\.3\\.${exp}\\.[A-Za-z0-9_-]{43}$`));
  });

  it("refuses a tampered event, version, expiry or signature", async () => {
    const value = await signGuestCookie(KEY, grant, NOW);
    const [eventId, version, exp, sig] = value.split(".") as [string, string, string, string];
    const other = "019a0b7e-0000-7000-8000-000000000002";
    const flip = (s: string) => (s.at(-1) === "A" ? `${s.slice(0, -1)}B` : `${s.slice(0, -1)}A`);
    for (const forged of [
      [other, version, exp, sig],
      [eventId, "4", exp, sig],
      [eventId, version, String(Number(exp) + 86_400), sig],
      [eventId, version, exp, flip(sig)],
    ]) {
      expect(await verifyGuestCookie(KEY, forged.join("."), NOW)).toBeNull();
    }
  });

  it("refuses a cookie signed with another key", async () => {
    const value = await signGuestCookie("another-session-key-not-a-secret-0123456789", grant, NOW);
    expect(await verifyGuestCookie(KEY, value, NOW)).toBeNull();
  });

  it("refuses malformed values without throwing", async () => {
    const value = await signGuestCookie(KEY, grant, NOW);
    for (const bad of [
      "",
      "x",
      value.replaceAll(".", "|"),
      `${value}.extra`,
      value.toUpperCase(),
      `${value.split(".").slice(0, 3).join(".")}.`,
      value.replace(".3.", ".03."),
      value.replace(".3.", ".0."),
      value.replace(".3.", ".-3."),
      "a".repeat(5000),
    ]) {
      expect(await verifyGuestCookie(KEY, bad, NOW)).toBeNull();
    }
  });

  it("fails closed on a missing or short key", async () => {
    await expect(signGuestCookie("", grant, NOW)).rejects.toThrow(/SESSION_KEY/);
    await expect(signGuestCookie("short", grant, NOW)).rejects.toThrow(/SESSION_KEY/);
    const value = await signGuestCookie(KEY, grant, NOW);
    await expect(verifyGuestCookie("", value, NOW)).rejects.toThrow(/SESSION_KEY/);
  });
});

describe("Set-Cookie headers", () => {
  it("scopes the cookie to the event's path with the DESIGN §11 attributes", () => {
    expect(guestCookie("abcdefghijklmnop", "v")).toBe(
      "g=v; Max-Age=2592000; Path=/e/abcdefghijklmnop; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("clears it with the same name, path and attributes", () => {
    expect(clearGuestCookie("abcdefghijklmnop")).toBe("g=; Max-Age=0; Path=/e/abcdefghijklmnop; HttpOnly; Secure; SameSite=Lax");
  });
});
