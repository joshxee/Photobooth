import { describe, expect, it } from "bun:test";
import { AUDIT_ACTIONS } from "../../shared/schemas";
import { ACTION_GROUPS, ACTION_LABELS, actorLabel, detailText, targetOf } from "./audit";
import { auditEntry, device, event } from "./testing";

describe("action labels", () => {
  it("every action the Worker can write has a label and sits in exactly one filter group", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(ACTION_LABELS[action], action).toBeTruthy();
      expect(ACTION_GROUPS.filter((g) => g.actions.includes(action)).length, action).toBe(1);
    }
    expect(Object.keys(ACTION_LABELS).sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(ACTION_GROUPS.flatMap((g) => g.actions).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it("uses plain words", () => {
    expect(ACTION_LABELS["photo.delete"]).toBe("Deleted a photo permanently");
    expect(ACTION_LABELS["event.rotate_link"]).toBe("Rotated the gallery link");
  });
});

describe("actorLabel", () => {
  it("says who, in words", () => {
    expect(actorLabel("josh@knockbox.nz")).toBe("josh@knockbox.nz");
    expect(actorLabel("system")).toBe("System (daily job)");
    expect(actorLabel("svc:abc.access")).toBe("Service token abc.access");
    expect(actorLabel("device:019a0b7e-0000-7000-8000-0000000000d1")).toBe("A booth");
  });

  it("names the booth when it is known", () => {
    const d = device();
    expect(actorLabel(`device:${d.id}`, new Map([[d.id, d]]))).toBe("Booth A");
  });
});

describe("targetOf", () => {
  const e = event();
  const events = new Map([[e.id, e]]);

  it("an event action names the event and links to it", () => {
    expect(targetOf(auditEntry({ action: "event.publish" }), events, new Map())).toEqual({ text: "Smith wedding", to: `/events/${e.id}` });
  });

  it("a purged or unknown event falls back to the name the entry recorded, then to a short ID, without a link", () => {
    const gone = auditEntry({ action: "event.purge", eventId: "019a0b7e-9999-7000-8000-000000000009", detail: { name: "Old party", photos: 4 } });
    expect(targetOf(gone, events, new Map())).toEqual({ text: "Old party (deleted)" });
    const unnamed = auditEntry({ action: "event.publish", eventId: "019a0b7e-9999-7000-8000-000000000009", targetId: null });
    expect(targetOf(unnamed, events, new Map())).toEqual({ text: "An event that no longer exists" });
  });

  it("a photo action names its session and shot and the event", () => {
    const entry = auditEntry({ action: "photo.hide", targetId: "019a0b7e-1000-7000-8000-000000000001", detail: { sessionId: "s-1", shot: 2, state: "READY" } });
    expect(targetOf(entry, events, new Map())).toEqual({ text: "Photo: session s-1, shot 2 in Smith wedding", to: `/events/${e.id}/photos` });
  });

  it("a photo action links to the event's photos, even for a photo that is now deleted", () => {
    const entry = auditEntry({ action: "photo.delete", detail: { sessionId: "s-1", shot: 2, state: "READY", hidden: false } });
    expect(targetOf(entry, events, new Map()).to).toBe(`/events/${e.id}/photos`);
  });

  it("a device action names the booth from its list, else the recorded name, else says it is gone", () => {
    const d = device();
    const devices = new Map([[d.id, d]]);
    expect(targetOf(auditEntry({ action: "device.revoke", eventId: null, targetId: d.id }), events, devices)).toEqual({ text: "Booth A", to: "/devices" });
    expect(targetOf(auditEntry({ action: "device.create", eventId: null, targetId: "x", detail: { name: "Booth Z" } }), events, new Map())).toEqual({ text: "Booth Z" });
    expect(targetOf(auditEntry({ action: "device.revoke", eventId: null, targetId: "x" }), events, new Map())).toEqual({ text: "A booth that is no longer listed" });
  });

  it("the daily prune has no target", () => {
    expect(targetOf(auditEntry({ action: "audit.prune", eventId: null, targetId: null }), events, new Map())).toEqual({ text: "—" });
  });
});

describe("detailText", () => {
  it("summarises what changed, never a secret", () => {
    expect(detailText(auditEntry({ action: "event.update", detail: { fields: ["name", "venue"] } }))).toBe("Changed name, venue");
    expect(detailText(auditEntry({ action: "event.rotate_link", detail: { accessVersion: 3 } }))).toBe("Link version 3");
    expect(detailText(auditEntry({ action: "event.delete", detail: { purgeAfter: "2026-10-31T12:00:00.000Z" } }))).toBe("Purges 31 Oct 2026");
    expect(detailText(auditEntry({ action: "event.purge", detail: { name: "Old party", photos: 4 } }))).toBe("4 photos removed");
    expect(detailText(auditEntry({ action: "audit.prune", detail: { rows: 12, olderThan: "2026-07-25T00:00:00.000Z" } }))).toBe("12 entries older than 25 Jul 2026");
    expect(detailText(auditEntry({ action: "photo.delete", detail: { sessionId: "s-1", shot: 2, state: "READY", hidden: true } }))).toBe("Was READY and hidden");
    expect(detailText(auditEntry({ action: "photo.hide", detail: { sessionId: "s-1", shot: 2, state: "PENDING" } }))).toBe("Was PENDING");
    expect(detailText(auditEntry({ action: "event.open", detail: null }))).toBe("");
  });

  it("an unknown action or shape reads as nothing rather than breaking the list", () => {
    expect(detailText(auditEntry({ action: "something.new", detail: { whatever: 1 } }))).toBe("");
    expect(detailText(auditEntry({ action: "event.update", detail: { fields: "oops" } }))).toBe("");
  });
});
