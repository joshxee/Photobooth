import { describe, expect, test } from "bun:test";

import { enrolledStatus, portalStatus, SMITH } from "../test/ipc";
import { formatLocalDate, portalSummary } from "./portalText";

describe("portal text", () => {
  test("a local date reads as a calendar date, whatever the tablet's time zone", () => {
    expect(formatLocalDate("2026-10-22")).toBe("Thu 22 Oct 2026");
    expect(formatLocalDate("2026-01-01")).toBe("Thu 1 Jan 2026");
    expect(formatLocalDate("2028-02-29")).toBe("Tue 29 Feb 2028");
    // Not a date: shown as given rather than as a wrong one.
    expect(formatLocalDate("2026-02-30")).toBe("2026-02-30");
    expect(formatLocalDate("22.10.2026")).toBe("22.10.2026");
  });

  test("the operator line covers every state", () => {
    expect(portalSummary(null)).toBe("Portal: checking…");
    expect(portalSummary(portalStatus())).toBe("Portal: not enrolled");
    expect(portalSummary(portalStatus({ problem: "damaged" }))).toBe(
      "Portal: enrolment needs attention (see Settings)",
    );
    expect(portalSummary(enrolledStatus())).toBe(
      "Portal: no event selected (photos stay on the SD card)",
    );
    expect(portalSummary(enrolledStatus({ selected_event: SMITH }))).toBe(
      "Portal: Smith wedding · Thu 22 Oct 2026",
    );
  });
});
