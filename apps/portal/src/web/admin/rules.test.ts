import { describe, expect, it } from "bun:test";
import { availableActions, backlogReport, confirmation, galleryChip, uploadChip } from "./rules";
import { NOW, device, event } from "./testing";

describe("availableActions (mirrors the Worker's state machine)", () => {
  it("a draft can be opened and published, not closed or suspended", () => {
    expect(availableActions(event(), NOW)).toEqual(["open", "publish", "rotate-link", "delete"]);
  });

  it("an open, live event can be closed and suspended", () => {
    expect(availableActions(event({ uploadStatus: "OPEN", galleryStatus: "LIVE" }), NOW)).toEqual(["close", "suspend", "rotate-link", "delete"]);
  });

  it("a closed event can be opened again while the upload window lasts", () => {
    expect(availableActions(event({ uploadStatus: "CLOSED", galleryStatus: "SUSPENDED" }), NOW)).toEqual(["open", "publish", "rotate-link", "delete"]);
  });

  it("an event past uploads_until can't be opened, but can still be published (D15)", () => {
    const past = event({ uploadStatus: "CLOSED", galleryStatus: "HIDDEN", uploadsUntil: new Date(NOW - 1000).toISOString() });
    expect(availableActions(past, NOW)).toEqual(["publish", "rotate-link", "delete"]);
  });

  it("the window closes at the instant, not after it", () => {
    const edge = event({ uploadsUntil: new Date(NOW).toISOString() });
    expect(availableActions(edge, NOW)).not.toContain("open");
    expect(availableActions(edge, NOW - 1)).toContain("open");
  });

  it("a deleted event can only be restored, until its purge date", () => {
    const deleted = event({ deletedAt: new Date(NOW - 1000).toISOString(), purgeAfter: new Date(NOW + 86_400_000).toISOString() });
    expect(availableActions(deleted, NOW)).toEqual(["restore"]);
    expect(availableActions({ ...deleted, purgeAfter: new Date(NOW).toISOString() }, NOW)).toEqual([]);
  });
});

describe("status chips", () => {
  it("names uploads and the gallery separately", () => {
    expect(uploadChip(event({ uploadStatus: "OPEN" }), NOW)).toEqual({ label: "Uploads open", tone: "ok" });
    expect(uploadChip(event({ uploadStatus: "CLOSED" }), NOW)).toEqual({ label: "Uploads closed", tone: "muted" });
    expect(uploadChip(event(), NOW)).toEqual({ label: "Uploads not open yet", tone: "muted" });
    expect(galleryChip(event({ galleryStatus: "LIVE" }))).toEqual({ label: "Gallery live", tone: "ok" });
    expect(galleryChip(event({ galleryStatus: "SUSPENDED" }))).toEqual({ label: "Gallery suspended", tone: "warn" });
    expect(galleryChip(event())).toEqual({ label: "Gallery hidden", tone: "muted" });
  });

  it("an OPEN event past uploads_until reads closed, as the booth sees it", () => {
    const past = event({ uploadStatus: "OPEN", uploadsUntil: new Date(NOW - 1).toISOString() });
    expect(uploadChip(past, NOW)).toEqual({ label: "Uploads closed", tone: "muted" });
  });
});

describe("backlogReport", () => {
  it("lists enrolled booths with queued items and says how fresh the figure is", () => {
    const report = backlogReport(
      [device({ name: "A", lastBacklog: 12, lastSeenAt: new Date(NOW - 60_000).toISOString() }), device({ id: "x2", name: "B", lastBacklog: 0 })],
      NOW,
    );
    expect(report.queued).toEqual([{ name: "A", backlog: 12, lastSeenAt: new Date(NOW - 60_000).toISOString() }]);
    expect(report.unknown).toEqual([]);
  });

  it("a booth not heard from for over 10 minutes has an unknown queue, whatever it last said", () => {
    const report = backlogReport([device({ name: "A", lastBacklog: 0, lastSeenAt: new Date(NOW - 11 * 60_000).toISOString() })], NOW);
    expect(report.unknown.map((d) => d.name)).toEqual(["A"]);
    expect(report.queued).toEqual([]);
  });

  it("keeps a stale booth with a backlog in both lists: the last report was non-zero", () => {
    const report = backlogReport([device({ name: "A", lastBacklog: 5, lastSeenAt: new Date(NOW - 20 * 60_000).toISOString() })], NOW);
    expect(report.queued.map((d) => d.name)).toEqual(["A"]);
    expect(report.unknown.map((d) => d.name)).toEqual(["A"]);
  });

  it("an enrolled booth that never reported a backlog is unknown", () => {
    const report = backlogReport([device({ name: "A", lastBacklog: null, lastSeenAt: null })], NOW);
    expect(report.unknown.map((d) => d.name)).toEqual(["A"]);
  });

  it("ignores revoked booths and codes that were never redeemed", () => {
    const report = backlogReport(
      [
        device({ name: "Revoked", revokedAt: new Date(NOW - 5000).toISOString(), lastBacklog: 9 }),
        device({ name: "Pending", enrolledAt: null, lastSeenAt: null, lastBacklog: null }),
      ],
      NOW,
    );
    expect(report).toEqual({ queued: [], unknown: [] });
  });
});

describe("confirmation", () => {
  const live = event({ name: "Smith wedding", uploadStatus: "OPEN", galleryStatus: "LIVE" });
  const none = { queued: [], unknown: [] };

  it("only the destructive actions ask", () => {
    for (const action of ["open", "publish", "restore"] as const) expect(confirmation(action, live, none)).toBeNull();
    for (const action of ["close", "suspend", "rotate-link", "delete"] as const) expect(confirmation(action, live, none)).not.toBeNull();
  });

  it("rotation warns that printed signage must be reprinted and that old links stop at once", () => {
    const c = confirmation("rotate-link", live, none)!;
    const text = c.paragraphs.join(" ");
    expect(text).toContain("reprint");
    expect(text).toContain("stops working");
    expect(c.danger).toBe(true);
    expect(c.confirmLabel).toBe("Rotate link");
  });

  it("suspension says it is a pause and that rotation is the revoke", () => {
    const text = confirmation("suspend", live, none)!.paragraphs.join(" ");
    expect(text).toContain("Publish");
    expect(text).toContain("same link");
    expect(text).toContain("Rotate");
  });

  it("deletion says photos go for good after 7 days and names the event", () => {
    const c = confirmation("delete", live, none)!;
    expect(c.title).toContain("Smith wedding");
    expect(c.paragraphs.join(" ")).toContain("7 days");
    expect(c.confirmLabel).toBe("Delete event");
  });

  it("closing uploads lists each booth's backlog", () => {
    const c = confirmation(
      "close",
      live,
      { queued: [{ name: "Booth A", backlog: 12, lastSeenAt: new Date(NOW - 60_000).toISOString() }], unknown: [] },
      NOW,
    )!;
    expect(c.warning).toContain("1 booth");
    expect(c.items).toEqual(["Booth A: 12 waiting to upload (last seen 1 min ago)"]);
    expect(c.confirmLabel).toBe("Close uploads anyway");
  });

  it("closing with every booth at zero has no warning", () => {
    const c = confirmation("close", live, none, NOW)!;
    expect(c.warning).toBeUndefined();
    expect(c.items).toBeUndefined();
    expect(c.confirmLabel).toBe("Close uploads");
  });

  it("closing says when a booth hasn't been heard from, so its queue is unknown", () => {
    const c = confirmation("close", live, { queued: [], unknown: [{ name: "Booth B", lastSeenAt: null }] }, NOW)!;
    expect(c.warning).toContain("can't tell");
    expect(c.items).toEqual(["Booth B: last seen never, so its queue is unknown"]);
  });

  it("closing says the device list could not be read", () => {
    const c = confirmation("close", live, null, NOW)!;
    expect(c.warning).toContain("couldn't check");
  });
});
