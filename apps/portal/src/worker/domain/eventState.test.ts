import { describe, expect, it } from "vitest";
import {
  acceptsUploads,
  applyEventAction,
  type EventAction,
  type EventState,
  galleryVisible,
  isDeleted,
  isExpired,
  isPurgeDue,
  purgeAfter,
  retentionUntil,
} from "./eventState";

const NOW = new Date("2026-10-22T10:00:00.000Z");

function state(overrides: Partial<EventState> = {}): EventState {
  return {
    upload_status: "DRAFT",
    gallery_status: "HIDDEN",
    share_token: "old-token",
    access_version: 1,
    retention_until: "2027-01-20T10:00:00.000Z",
    deleted_at: null,
    purge_after: null,
    ...overrides,
  };
}

function apply(s: EventState, action: EventAction, now = NOW) {
  return applyEventAction(s, action, now);
}

describe("upload_status transitions", () => {
  it.each([
    ["DRAFT", "open", "OPEN"],
    ["CLOSED", "open", "OPEN"],
    ["OPEN", "close", "CLOSED"],
  ] as const)("%s --%s--> %s", (from, type, to) => {
    const result = apply(state({ upload_status: from }), { type });
    expect(result).toEqual({ ok: true, next: state({ upload_status: to }) });
  });

  it.each([
    ["OPEN", "open"],
    ["DRAFT", "close"],
    ["CLOSED", "close"],
  ] as const)("%s cannot %s", (from, type) => {
    expect(apply(state({ upload_status: from }), { type })).toEqual({ ok: false, reason: "invalid_transition" });
  });
});

describe("gallery_status transitions", () => {
  it.each([
    ["HIDDEN", "publish", "LIVE"],
    ["SUSPENDED", "publish", "LIVE"],
    ["LIVE", "suspend", "SUSPENDED"],
  ] as const)("%s --%s--> %s", (from, type, to) => {
    const result = apply(state({ gallery_status: from }), { type });
    expect(result).toEqual({ ok: true, next: state({ gallery_status: to }) });
  });

  it.each([
    ["LIVE", "publish"],
    ["HIDDEN", "suspend"],
    ["SUSPENDED", "suspend"],
  ] as const)("%s cannot %s", (from, type) => {
    expect(apply(state({ gallery_status: from }), { type })).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("upload and gallery statuses are independent", () => {
    const result = apply(state({ upload_status: "CLOSED", gallery_status: "LIVE" }), { type: "suspend" });
    expect(result).toEqual({ ok: true, next: state({ upload_status: "CLOSED", gallery_status: "SUSPENDED" }) });
  });
});

describe("rotate", () => {
  it("replaces the token and bumps access_version, in any status", () => {
    const result = apply(state({ gallery_status: "LIVE", access_version: 3 }), { type: "rotate", shareToken: "new-token" });
    expect(result).toEqual({
      ok: true,
      next: state({ gallery_status: "LIVE", access_version: 4, share_token: "new-token" }),
    });
  });

  it("refuses to 'rotate' to the same token", () => {
    expect(apply(state(), { type: "rotate", shareToken: "old-token" })).toEqual({ ok: false, reason: "invalid_transition" });
  });
});

describe("delete and restore", () => {
  it("delete sets deleted_at and purge_after = +7 days", () => {
    const result = apply(state({ upload_status: "OPEN", gallery_status: "LIVE" }), { type: "delete" });
    expect(result).toEqual({
      ok: true,
      next: state({
        upload_status: "OPEN",
        gallery_status: "LIVE",
        deleted_at: "2026-10-22T10:00:00.000Z",
        purge_after: "2026-10-29T10:00:00.000Z",
      }),
    });
  });

  const deleted = state({ deleted_at: "2026-10-20T10:00:00.000Z", purge_after: "2026-10-27T10:00:00.000Z" });

  it("restore within 7 days clears both", () => {
    expect(apply(deleted, { type: "restore" })).toEqual({ ok: true, next: state() });
  });

  it("restore at or after purge_after is refused", () => {
    expect(apply(deleted, { type: "restore" }, new Date("2026-10-27T10:00:00.000Z"))).toEqual({
      ok: false,
      reason: "purge_due",
    });
  });

  it("a deleted event accepts no other action", () => {
    for (const action of [
      { type: "open" },
      { type: "close" },
      { type: "publish" },
      { type: "suspend" },
      { type: "delete" },
      { type: "rotate", shareToken: "x" },
    ] as EventAction[]) {
      expect(apply(deleted, action)).toEqual({ ok: false, reason: "deleted" });
    }
  });

  it("restore of an event that isn't deleted is refused", () => {
    expect(apply(state(), { type: "restore" })).toEqual({ ok: false, reason: "invalid_transition" });
  });
});

describe("expiry", () => {
  const expired = state({ retention_until: "2026-10-22T10:00:00.000Z" });

  it("an event is expired from retention_until on", () => {
    expect(isExpired(expired, NOW)).toBe(true);
    expect(isExpired(expired, new Date("2026-10-22T09:59:59.999Z"))).toBe(false);
  });

  it("an expired event can't be opened or published", () => {
    expect(apply(expired, { type: "open" })).toEqual({ ok: false, reason: "expired" });
    expect(apply(expired, { type: "publish" })).toEqual({ ok: false, reason: "expired" });
  });

  it("an expired event can still be closed, suspended, rotated and deleted", () => {
    expect(apply(state({ ...expired, upload_status: "OPEN" }), { type: "close" }).ok).toBe(true);
    expect(apply(state({ ...expired, gallery_status: "LIVE" }), { type: "suspend" }).ok).toBe(true);
    expect(apply(expired, { type: "rotate", shareToken: "n" }).ok).toBe(true);
    expect(apply(expired, { type: "delete" }).ok).toBe(true);
  });
});

describe("predicates", () => {
  const open = state({ upload_status: "OPEN", gallery_status: "LIVE" });
  const deleted = { ...open, deleted_at: "2026-10-21T10:00:00.000Z", purge_after: "2026-10-28T10:00:00.000Z" };
  const expired = { ...open, retention_until: "2026-10-01T00:00:00.000Z" };

  it("acceptsUploads: OPEN, not deleted, not expired", () => {
    expect(acceptsUploads(open, NOW)).toBe(true);
    expect(acceptsUploads({ ...open, upload_status: "CLOSED" }, NOW)).toBe(false);
    expect(acceptsUploads({ ...open, upload_status: "DRAFT" }, NOW)).toBe(false);
    expect(acceptsUploads(deleted, NOW)).toBe(false);
    expect(acceptsUploads(expired, NOW)).toBe(false);
  });

  it("galleryVisible: LIVE, not deleted, not expired", () => {
    expect(galleryVisible(open, NOW)).toBe(true);
    expect(galleryVisible({ ...open, gallery_status: "SUSPENDED" }, NOW)).toBe(false);
    expect(galleryVisible({ ...open, gallery_status: "HIDDEN" }, NOW)).toBe(false);
    expect(galleryVisible(deleted, NOW)).toBe(false);
    expect(galleryVisible(expired, NOW)).toBe(false);
  });

  it("isDeleted and isPurgeDue", () => {
    expect(isDeleted(open)).toBe(false);
    expect(isDeleted(deleted)).toBe(true);
    expect(isPurgeDue(deleted, NOW)).toBe(false);
    expect(isPurgeDue(deleted, new Date("2026-10-28T10:00:00.000Z"))).toBe(true);
    expect(isPurgeDue(open, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("dates", () => {
  it("retention_until is ends_at + 90 days", () => {
    expect(retentionUntil("2026-10-22T10:00:00.000Z")).toBe("2027-01-20T10:00:00.000Z");
  });

  it("purge_after is deleted_at + 7 days", () => {
    expect(purgeAfter(new Date("2026-12-30T23:00:00.000Z"))).toBe("2027-01-06T23:00:00.000Z");
  });
});
