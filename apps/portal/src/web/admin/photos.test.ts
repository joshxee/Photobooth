import { describe, expect, it } from "bun:test";
import { type PhotoFilter, filterQuery, matchesFilter, neighbour, photoChips, photoLabel } from "./photos";
import { photoDeleteConfirmation } from "./rules";
import { event, photo } from "./testing";

const ALL: PhotoFilter = { state: "ALL", visibility: "all" };

describe("matchesFilter / filterQuery", () => {
  it("all keeps everything and asks for no filter", () => {
    expect(matchesFilter(photo({ state: "PENDING", hidden: true }), ALL)).toBe(true);
    expect(filterQuery(ALL)).toEqual({});
  });

  it("a state filter keeps that state only", () => {
    const f: PhotoFilter = { state: "REJECTED", visibility: "all" };
    expect(matchesFilter(photo({ state: "REJECTED" }), f)).toBe(true);
    expect(matchesFilter(photo({ state: "READY" }), f)).toBe(false);
    expect(filterQuery(f)).toEqual({ state: "REJECTED" });
  });

  it("visibility keeps hidden or visible photos only", () => {
    const hidden: PhotoFilter = { state: "ALL", visibility: "hidden" };
    const visible: PhotoFilter = { state: "ALL", visibility: "visible" };
    expect(matchesFilter(photo({ hidden: true }), hidden)).toBe(true);
    expect(matchesFilter(photo({ hidden: false }), hidden)).toBe(false);
    expect(matchesFilter(photo({ hidden: false }), visible)).toBe(true);
    expect(matchesFilter(photo({ hidden: true }), visible)).toBe(false);
    expect(filterQuery(hidden)).toEqual({ hidden: true });
    expect(filterQuery(visible)).toEqual({ hidden: false });
    expect(filterQuery({ state: "READY", visibility: "hidden" })).toEqual({ state: "READY", hidden: true });
  });
});

describe("neighbour", () => {
  const ids = ["a", "b", "c"];
  it("is the next photo, else the previous one, else nothing", () => {
    expect(neighbour(ids, "a")).toBe("b");
    expect(neighbour(ids, "b")).toBe("c");
    expect(neighbour(ids, "c")).toBe("b");
    expect(neighbour(["a"], "a")).toBeNull();
    expect(neighbour(ids, "zzz")).toBeNull();
  });
});

describe("photoChips / photoLabel", () => {
  it("names a rejected photo's reason and marks a hidden one", () => {
    expect(photoChips(photo({ state: "READY" }))).toEqual([]);
    expect(photoChips(photo({ state: "PENDING" }))).toEqual([{ label: "Pending", tone: "warn" }]);
    expect(photoChips(photo({ state: "REJECTED", rejectReason: "SOF too short" }))).toEqual([{ label: "Rejected: SOF too short", tone: "danger" }]);
    expect(photoChips(photo({ hidden: true }))).toEqual([{ label: "Hidden", tone: "muted" }]);
  });

  it("a label is the session and shot", () => {
    expect(photoLabel(photo({ sessionId: "19a0b6c1-1", shot: 2 }))).toBe("session 19a0b6c1-1, shot 2");
  });
});

describe("photoDeleteConfirmation", () => {
  const c = photoDeleteConfirmation(photo({ sessionId: "s-1", shot: 3 }), event({ name: "Smith wedding" }));

  it("names the consequence: gone from guests and storage now, no undo, cached copies, the SD card", () => {
    const text = [c.title, ...c.paragraphs, c.warning ?? "", ...(c.items ?? [])].join("\n");
    expect(text).toContain("removed from the gallery and from storage now");
    expect(text).toContain("can't be undone");
    expect(text).toContain("browser");
    expect(text).toContain("SD card");
    expect(c.items?.join(" ")).toContain("session s-1, shot 3");
  });

  it("is a danger confirmation that says exactly what the button does", () => {
    expect(c.danger).toBe(true);
    expect(c.confirmLabel).toBe("Delete permanently");
  });
});
