import { describe, expect, it } from "bun:test";
import { countdown, formatDay, formatInZone, localToUtc, relativeTime, timeZones, utcToLocal } from "./time";

describe("localToUtc / utcToLocal", () => {
  it("converts a New Zealand summer time (UTC+13) to UTC", () => {
    expect(localToUtc("2026-12-20T14:30", "Pacific/Auckland")).toEqual({ ok: true, iso: "2026-12-20T01:30:00.000Z" });
  });

  it("converts a New Zealand winter time (UTC+12) to UTC", () => {
    expect(localToUtc("2026-07-04T14:30", "Pacific/Auckland")).toEqual({ ok: true, iso: "2026-07-04T02:30:00.000Z" });
  });

  it("converts across the date line to the previous UTC day", () => {
    expect(localToUtc("2026-10-24T01:00", "Pacific/Auckland")).toEqual({ ok: true, iso: "2026-10-23T12:00:00.000Z" });
  });

  it("handles a zone behind UTC", () => {
    expect(localToUtc("2026-07-01T20:00", "America/New_York")).toEqual({ ok: true, iso: "2026-07-02T00:00:00.000Z" });
  });

  it("uses the offset in force on the day, not today's", () => {
    // NZ daylight time starts 2026-09-27 02:00 local; 12:00 the day before is still UTC+12.
    expect(localToUtc("2026-09-26T12:00", "Pacific/Auckland")).toEqual({ ok: true, iso: "2026-09-26T00:00:00.000Z" });
    expect(localToUtc("2026-09-28T12:00", "Pacific/Auckland")).toEqual({ ok: true, iso: "2026-09-27T23:00:00.000Z" });
  });

  it("refuses a local time that doesn't exist (the hour skipped when the clocks go forward)", () => {
    expect(localToUtc("2026-09-27T02:30", "Pacific/Auckland")).toEqual({ ok: false, reason: "That time doesn't exist in this time zone (the clocks go forward)." });
  });

  it("takes the first of the two repeated times when the clocks go back", () => {
    // NZ daylight time ends 2027-04-04 03:00 local (back to 02:00): 02:30 happens twice.
    expect(localToUtc("2027-04-04T02:30", "Pacific/Auckland")).toEqual({ ok: true, iso: "2027-04-03T13:30:00.000Z" });
  });

  it("refuses malformed input and unknown zones", () => {
    expect(localToUtc("", "Pacific/Auckland").ok).toBe(false);
    expect(localToUtc("2026-13-40T99:00", "Pacific/Auckland").ok).toBe(false);
    expect(localToUtc("2026-12-20T14:30", "Not/AZone").ok).toBe(false);
  });

  it("round-trips through utcToLocal", () => {
    for (const [local, zone] of [
      ["2026-12-20T14:30", "Pacific/Auckland"],
      ["2026-07-01T20:00", "America/New_York"],
      ["2026-03-28T01:30", "Europe/London"],
      ["2026-06-15T09:00", "Asia/Kolkata"],
    ] as const) {
      const utc = localToUtc(local, zone);
      expect(utc.ok).toBe(true);
      if (utc.ok) expect(utcToLocal(utc.iso, zone)).toBe(local);
    }
  });

  it("formats the editor's value in the event's zone", () => {
    expect(utcToLocal("2026-12-20T01:30:00.000Z", "Pacific/Auckland")).toBe("2026-12-20T14:30");
    expect(utcToLocal("2026-12-20T00:05:00.000Z", "UTC")).toBe("2026-12-20T00:05");
  });
});

describe("formatInZone / formatDay", () => {
  it("shows the date and time in the event's zone", () => {
    expect(formatInZone("2026-12-20T01:30:00.000Z", "Pacific/Auckland")).toBe("20 Dec 2026, 14:30");
  });

  it("shows a date alone", () => {
    expect(formatDay("2026-12-20T11:30:00.000Z", "Pacific/Auckland")).toBe("21 Dec 2026");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("says never for no timestamp", () => expect(relativeTime(null, now)).toBe("never"));
  it("rounds a few seconds to just now", () => expect(relativeTime(ago(20_000), now)).toBe("just now"));
  it("counts minutes", () => expect(relativeTime(ago(3 * 60_000 + 5_000), now)).toBe("3 min ago"));
  it("counts hours", () => expect(relativeTime(ago(5 * 3_600_000), now)).toBe("5 h ago"));
  it("counts days", () => expect(relativeTime(ago(3 * 86_400_000), now)).toBe("3 d ago"));
  it("treats a clock a little ahead of ours as just now", () => expect(relativeTime(new Date(now + 4_000).toISOString(), now)).toBe("just now"));
});

describe("countdown", () => {
  it("shows minutes and seconds left", () => {
    expect(countdown(Date.parse("2026-10-23T12:10:00.000Z"), Date.parse("2026-10-23T12:00:00.000Z"))).toEqual({ expired: false, text: "10:00" });
    expect(countdown(Date.parse("2026-10-23T12:10:00.000Z"), Date.parse("2026-10-23T12:09:55.500Z"))).toEqual({ expired: false, text: "0:05" });
  });

  it("expires at the deadline, not a second after", () => {
    expect(countdown(1000, 1000)).toEqual({ expired: true, text: "0:00" });
    expect(countdown(1000, 5000)).toEqual({ expired: true, text: "0:00" });
  });
});

describe("timeZones", () => {
  it("lists IANA zones including the defaults used here", () => {
    const zones = timeZones();
    expect(zones).toContain("Pacific/Auckland");
    expect(zones).toContain("UTC");
    expect(new Set(zones).size).toBe(zones.length);
  });
});
