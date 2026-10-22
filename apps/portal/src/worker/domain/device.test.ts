import { describe, expect, it } from "vitest";
import { LIMITS } from "../../shared/schemas";
import {
  ENROL_CODE_TTL_MS,
  enrolCodeExpiresAt,
  HEARTBEAT_INTERVAL_MS,
  heartbeatDue,
  parseAppVersion,
  parseBearer,
  parseOutboxDepth,
} from "./device";

const NOW = new Date("2026-10-22T10:00:00.000Z");
const CREDENTIAL = "A".repeat(20) + "b_-" + "9".repeat(20);

describe("enrolment code expiry", () => {
  it("is 10 minutes after issue, in toISOString form", () => {
    expect(ENROL_CODE_TTL_MS).toBe(10 * 60 * 1000);
    expect(enrolCodeExpiresAt(NOW)).toBe("2026-10-22T10:10:00.000Z");
  });
});

describe("heartbeatDue", () => {
  it("is due for a device never seen", () => {
    expect(heartbeatDue(null, NOW)).toBe(true);
  });

  it("is not due within a minute of the last write, and due from a minute on", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(heartbeatDue("2026-10-22T09:59:00.001Z", NOW)).toBe(false);
    expect(heartbeatDue("2026-10-22T10:00:00.000Z", NOW)).toBe(false);
    expect(heartbeatDue("2026-10-22T09:59:00.000Z", NOW)).toBe(true);
    expect(heartbeatDue("2026-10-21T10:00:00.000Z", NOW)).toBe(true);
  });

  it("is due when the stored time is in the future (a clock that went backwards)", () => {
    expect(heartbeatDue("2026-10-22T10:05:00.000Z", NOW)).toBe(true);
  });
});

describe("parseOutboxDepth", () => {
  it("reads a non-negative integer", () => {
    expect(parseOutboxDepth("0")).toBe(0);
    expect(parseOutboxDepth("42")).toBe(42);
    expect(parseOutboxDepth(" 7 ")).toBe(7);
  });

  it("clamps to 0–100000", () => {
    expect(LIMITS.outboxDepthMax).toBe(100_000);
    expect(parseOutboxDepth("-5")).toBe(0);
    expect(parseOutboxDepth("100000")).toBe(100_000);
    expect(parseOutboxDepth("100001")).toBe(100_000);
    expect(parseOutboxDepth("99999999999999999999999")).toBe(100_000);
  });

  it("ignores a missing or non-integer header", () => {
    for (const bad of [undefined, "", " ", "abc", "1.5", "1e3", "0x10", "12abc", "Infinity", "NaN", "--1"]) {
      expect(parseOutboxDepth(bad)).toBeNull();
    }
  });
});

describe("parseAppVersion", () => {
  it("keeps a short printable version, trimmed", () => {
    expect(parseAppVersion("0.4.0")).toBe("0.4.0");
    expect(parseAppVersion(" 1.2.3-beta+5 ")).toBe("1.2.3-beta+5");
    expect(parseAppVersion("x".repeat(32))).toBe("x".repeat(32));
  });

  it("ignores a missing, empty, long or non-printable value", () => {
    for (const bad of [undefined, "", "   ", "x".repeat(33), "1.\n0", "1.0\u0000", "versión"]) {
      expect(parseAppVersion(bad)).toBeNull();
    }
  });
});

describe("parseBearer", () => {
  it("reads a 43-character base64url credential", () => {
    expect(parseBearer(`Bearer ${CREDENTIAL}`)).toBe(CREDENTIAL);
    expect(parseBearer(`bearer ${CREDENTIAL}`)).toBe(CREDENTIAL);
  });

  it("refuses anything else", () => {
    for (const bad of [
      undefined,
      "",
      CREDENTIAL,
      `Basic ${CREDENTIAL}`,
      `Bearer ${CREDENTIAL}x`,
      `Bearer ${CREDENTIAL.slice(1)}`,
      `Bearer ${CREDENTIAL.slice(1)}=`,
      `Bearer  ${CREDENTIAL}`,
      `Bearer ${CREDENTIAL} `,
      `Bearer ${CREDENTIAL.slice(1)}+`,
    ]) {
      expect(parseBearer(bad)).toBeNull();
    }
  });
});
