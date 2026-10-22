import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeCursor } from "../domain/cursor";
import { applyEventAction } from "../domain/eventState";
import { newId } from "../domain/ids";
import { deviceRow, eventRow, photoRow, resetDb, T0 } from "../test/factories";
import { insertAudit, insertAuditIfDeviceActive, insertAuditIfEventAt, insertEnrolAudit, listAudit } from "./audit";
import {
  type DeviceRow,
  getDevice,
  getDeviceByTokenHash,
  insertDevice,
  listDevices,
  recordHeartbeat,
  redeemEnrolCode,
  revokeDevice,
  setEnrolCode,
} from "./devices";
import { getEvent, getEventByPublicId, insertEvent, listEvents, listOpenEvents, OPEN_EVENTS_MAX, updateEvent } from "./events";
import {
  countPhotos,
  deletePhoto,
  getPhoto,
  insertPhotoIfUnderLimit,
  listGalleryPage,
  markVariantStored,
  publishPhotoIfComplete,
  rejectPhoto,
  setPhotoHidden,
} from "./photos";

const db = env.DB;
const NOW = new Date("2026-10-22T10:00:00.000Z");

beforeEach(resetDb);

function redeem(args: { codeHash: string; tokenHash: string; name?: string; appVersion: string; now: Date }) {
  return redeemEnrolCode(db, { name: "Booth 1", ...args }).first<DeviceRow>();
}

async function setup(eventOverrides = {}) {
  const event = eventRow(eventOverrides);
  const device = deviceRow();
  await db.batch([insertEvent(db, event), insertDevice(db, device)]);
  return { event, device };
}

describe("events", () => {
  it("round-trips a row by id and by public_id", async () => {
    const event = eventRow();
    await insertEvent(db, event).run();
    expect(await getEvent(db, event.id)).toEqual(event);
    expect(await getEventByPublicId(db, event.public_id)).toEqual({ event, rowsRead: 1 });
    expect(await getEvent(db, "missing")).toBeNull();
  });

  it("lists every event (deleted included) for admins, newest start first", async () => {
    const older = eventRow({ starts_at: "2026-01-01T00:00:00.000Z", ends_at: "2026-01-01T06:00:00.000Z" });
    const newer = eventRow({ deleted_at: T0, purge_after: "2026-10-29T09:00:00.000Z" });
    await db.batch([insertEvent(db, older), insertEvent(db, newer)]);
    expect((await listEvents(db)).map((e) => e.id)).toEqual([newer.id, older.id]);
  });

  it("lists OPEN, non-deleted events inside their upload window for booths", async () => {
    const open = eventRow({ upload_status: "OPEN" });
    const rows = [
      open,
      eventRow({ upload_status: "CLOSED" }),
      eventRow({ upload_status: "DRAFT" }),
      eventRow({ upload_status: "OPEN", deleted_at: T0, purge_after: "2026-10-29T09:00:00.000Z" }),
      eventRow({ upload_status: "OPEN", uploads_until: "2026-10-22T10:00:00.000Z" }),
    ];
    await db.batch(rows.map((r) => insertEvent(db, r)));
    expect((await listOpenEvents(db, NOW)).map((e) => e.id)).toEqual([open.id]);
  });

  it("lists at most 100 open events (the device response's cap), soonest start first", async () => {
    const rows = Array.from({ length: 101 }, (_, i) =>
      eventRow({ upload_status: "OPEN", starts_at: new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 60_000).toISOString() }),
    );
    await db.batch(rows.map((r) => insertEvent(db, r)));
    const listed = await listOpenEvents(db, NOW);
    expect(listed).toHaveLength(OPEN_EVENTS_MAX);
    expect(listed.map((e) => e.id)).toEqual(rows.slice(0, 100).map((r) => r.id));
  });

  it("saves a transition, guarded by the updated_at it was read at", async () => {
    const event = eventRow({ upload_status: "DRAFT" });
    await insertEvent(db, event).run();
    const result = applyEventAction(event, { type: "open" }, NOW);
    if (!result.ok) throw new Error("expected ok");
    const saved = { ...event, ...result.next, updated_at: NOW.toISOString() };

    expect((await updateEvent(db, saved, event.updated_at).run()).meta.changes).toBe(1);
    expect(await getEvent(db, event.id)).toEqual(saved);
    // A second writer that read the old row loses: nothing changes.
    expect((await updateEvent(db, { ...saved, name: "stale" }, event.updated_at).run()).meta.changes).toBe(0);
    expect((await getEvent(db, event.id))?.name).toBe(event.name);
  });

  it("never updates id, public_id or created_at", async () => {
    const event = eventRow();
    await insertEvent(db, event).run();
    await updateEvent(db, { ...event, public_id: "changed", created_at: "x", updated_at: NOW.toISOString() }, event.updated_at).run();
    const row = await getEvent(db, event.id);
    expect(row?.public_id).toBe(event.public_id);
    expect(row?.created_at).toBe(event.created_at);
  });
});

describe("devices", () => {
  it("round-trips a row and lists devices in creation order", async () => {
    const first = deviceRow({ id: newId(new Date("2026-01-01T00:00:00.000Z")) });
    const second = deviceRow({ id: newId(new Date("2026-01-02T00:00:00.000Z")), name: "Booth 2" });
    await db.batch([insertDevice(db, second), insertDevice(db, first)]);
    expect(await getDevice(db, first.id)).toEqual(first);
    expect((await listDevices(db)).map((d) => d.id)).toEqual([first.id, second.id]);
  });

  it("redeems an unexpired enrolment code exactly once, naming the device and marking it seen", async () => {
    const device = deviceRow();
    await insertDevice(db, device).run();
    await setEnrolCode(db, device.id, "c".repeat(64), "2026-10-22T10:10:00.000Z").run();

    const enrolled = await redeem({ codeHash: "c".repeat(64), tokenHash: "t".repeat(64), name: "Front door", appVersion: "1.2.3", now: NOW });
    expect(enrolled).toMatchObject({
      id: device.id,
      name: "Front door",
      token_hash: "t".repeat(64),
      enrolled_at: NOW.toISOString(),
      last_seen_at: NOW.toISOString(),
      app_version: "1.2.3",
      enrol_code_hash: null,
      enrol_expires_at: null,
    });
    expect(await getDeviceByTokenHash(db, "t".repeat(64))).toEqual(enrolled);
    // Single use.
    expect(await redeem({ codeHash: "c".repeat(64), tokenHash: "u".repeat(64), appVersion: "1", now: NOW })).toBeNull();
  });

  it("refuses an expired code, a revoked device and an unknown code", async () => {
    const expired = deviceRow();
    const revoked = deviceRow({ revoked_at: T0 });
    await db.batch([
      insertDevice(db, expired),
      insertDevice(db, revoked),
      setEnrolCode(db, expired.id, "1".repeat(64), NOW.toISOString()),
      setEnrolCode(db, revoked.id, "2".repeat(64), "2026-10-22T10:10:00.000Z"),
    ]);
    for (const codeHash of ["1".repeat(64), "2".repeat(64), "3".repeat(64)]) {
      expect(await redeem({ codeHash, tokenHash: "t".repeat(64), appVersion: "1", now: NOW })).toBeNull();
    }
  });

  it("re-issuing a code replaces the old one", async () => {
    const device = deviceRow();
    await insertDevice(db, device).run();
    await setEnrolCode(db, device.id, "1".repeat(64), "2026-10-22T10:10:00.000Z").run();
    await setEnrolCode(db, device.id, "2".repeat(64), "2026-10-22T10:10:00.000Z").run();
    expect(await redeem({ codeHash: "1".repeat(64), tokenHash: "t".repeat(64), appVersion: "1", now: NOW })).toBeNull();
    expect(await redeem({ codeHash: "2".repeat(64), tokenHash: "t".repeat(64), appVersion: "1", now: NOW })).not.toBeNull();
  });

  it("revoke sets revoked_at and clears any pending code", async () => {
    const device = deviceRow();
    await insertDevice(db, device).run();
    await setEnrolCode(db, device.id, "1".repeat(64), "2026-10-22T10:10:00.000Z").run();
    expect((await revokeDevice(db, device.id, NOW).run()).meta.changes).toBe(1);
    expect(await getDevice(db, device.id)).toMatchObject({ revoked_at: NOW.toISOString(), enrol_code_hash: null });
    // Revoking twice keeps the first time.
    expect((await revokeDevice(db, device.id, new Date("2026-10-23T00:00:00.000Z")).run()).meta.changes).toBe(0);
  });

  it("re-enrolling replaces the credential: the old one stops working", async () => {
    const device = deviceRow({ token_hash: "o".repeat(64), enrolled_at: T0 });
    await insertDevice(db, device).run();
    await setEnrolCode(db, device.id, "1".repeat(64), "2026-10-22T10:10:00.000Z").run();
    expect(await redeem({ codeHash: "1".repeat(64), tokenHash: "n".repeat(64), appVersion: "2", now: NOW })).not.toBeNull();
    expect(await getDeviceByTokenHash(db, "o".repeat(64))).toBeNull();
    expect((await getDeviceByTokenHash(db, "n".repeat(64)))?.id).toBe(device.id);
  });
});

describe("devices: the heartbeat", () => {
  const SEEN = "2026-10-22T09:58:00.000Z";

  async function enrolled(overrides: Partial<DeviceRow> = {}) {
    const device = deviceRow({ token_hash: "t".repeat(64), enrolled_at: T0, last_seen_at: SEEN, last_backlog: 3, app_version: "1.0.0", ...overrides });
    await insertDevice(db, device).run();
    return device;
  }

  it("writes last seen, backlog and app version", async () => {
    const device = await enrolled();
    const { meta } = await recordHeartbeat(db, { id: device.id, now: NOW, backlog: 12, appVersion: "1.1.0" }).run();
    expect(meta.changes).toBe(1);
    expect(await getDevice(db, device.id)).toMatchObject({ last_seen_at: NOW.toISOString(), last_backlog: 12, app_version: "1.1.0" });
  });

  it("keeps the stored backlog and version when the request didn't send them", async () => {
    const device = await enrolled();
    await recordHeartbeat(db, { id: device.id, now: NOW, backlog: null, appVersion: null }).run();
    expect(await getDevice(db, device.id)).toMatchObject({ last_seen_at: NOW.toISOString(), last_backlog: 3, app_version: "1.0.0" });
  });

  it("writes at most once a minute, even when two requests race past the route's check", async () => {
    const device = await enrolled({ last_seen_at: "2026-10-22T09:59:00.001Z" });
    expect((await recordHeartbeat(db, { id: device.id, now: NOW, backlog: 9, appVersion: null }).run()).meta.changes).toBe(0);
    expect((await getDevice(db, device.id))?.last_backlog).toBe(3);
    const later = new Date("2026-10-22T10:00:00.001Z");
    expect((await recordHeartbeat(db, { id: device.id, now: later, backlog: 9, appVersion: null }).run()).meta.changes).toBe(1);
  });

  it("writes when the stored time is in the future, and never for a revoked device", async () => {
    const future = await enrolled({ last_seen_at: "2026-10-22T11:00:00.000Z" });
    expect((await recordHeartbeat(db, { id: future.id, now: NOW, backlog: 1, appVersion: null }).run()).meta.changes).toBe(1);
    const revoked = await enrolled({ token_hash: "r".repeat(64), revoked_at: T0, last_seen_at: null });
    expect((await recordHeartbeat(db, { id: revoked.id, now: NOW, backlog: 1, appVersion: null }).run()).meta.changes).toBe(0);
  });
});

describe("photos: the atomic insert", () => {
  it("creates a PENDING photo and returns the row", async () => {
    const { event, device } = await setup();
    const photo = photoRow({ event_id: event.id, device_id: device.id });
    const result = await insertPhotoIfUnderLimit(db, photo);
    expect(result.outcome).toBe("created");
    expect(result.photo).toEqual({
      ...photo,
      thumb_stored: 0,
      hd_stored: 0,
      state: "PENDING",
      reject_reason: null,
      hidden: 0,
      published_at: null,
    });
    expect(await getPhoto(db, photo.id)).toEqual(result.photo);
  });

  it("a duplicate intent is a no-op that returns the existing row", async () => {
    const { event, device } = await setup();
    const first = photoRow({ event_id: event.id, device_id: device.id });
    await insertPhotoIfUnderLimit(db, first);
    // Same device and clientPhotoId, new server id and different hashes: the first row wins.
    const retry = { ...first, id: newId(), hd_sha256: "c".repeat(64) };
    const result = await insertPhotoIfUnderLimit(db, retry);
    expect(result.outcome).toBe("existing");
    expect(result.photo?.id).toBe(first.id);
    expect(result.photo?.hd_sha256).toBe(first.hd_sha256);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM photos").first<number>("n");
    expect(count).toBe(1);
  });

  it("the same clientPhotoId from another device is a different photo", async () => {
    const { event, device } = await setup();
    const other = deviceRow();
    await insertDevice(db, other).run();
    const photo = photoRow({ event_id: event.id, device_id: device.id });
    await insertPhotoIfUnderLimit(db, photo);
    const result = await insertPhotoIfUnderLimit(db, { ...photo, id: newId(), device_id: other.id });
    expect(result.outcome).toBe("created");
  });

  it("refuses a new photo at the limit, but still returns an existing one", async () => {
    const { event, device } = await setup({ photo_limit: 1 });
    const first = photoRow({ event_id: event.id, device_id: device.id });
    expect((await insertPhotoIfUnderLimit(db, first)).outcome).toBe("created");
    expect(await insertPhotoIfUnderLimit(db, photoRow({ event_id: event.id, device_id: device.id }))).toEqual({
      outcome: "limit",
      photo: null,
    });
    expect((await insertPhotoIfUnderLimit(db, { ...first, id: newId() })).outcome).toBe("existing");
  });

  it("counts only this event's photos against its limit", async () => {
    const { event, device } = await setup({ photo_limit: 1 });
    const other = eventRow();
    await insertEvent(db, other).run();
    await insertPhotoIfUnderLimit(db, photoRow({ event_id: other.id, device_id: device.id }));
    expect((await insertPhotoIfUnderLimit(db, photoRow({ event_id: event.id, device_id: device.id }))).outcome).toBe("created");
  });

  it("is atomic: 2 concurrent inserts at limit − 1 create exactly one photo", async () => {
    const { event, device } = await setup({ photo_limit: 3 });
    for (let i = 0; i < 2; i++) await insertPhotoIfUnderLimit(db, photoRow({ event_id: event.id, device_id: device.id }));

    const results = await Promise.all([
      insertPhotoIfUnderLimit(db, photoRow({ event_id: event.id, device_id: device.id })),
      insertPhotoIfUnderLimit(db, photoRow({ event_id: event.id, device_id: device.id })),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["created", "limit"]);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM photos WHERE event_id = ?").bind(event.id).first<number>("n");
    expect(count).toBe(3);
  });

  it("is atomic under many concurrent inserts", async () => {
    const { event, device } = await setup({ photo_limit: 5 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => insertPhotoIfUnderLimit(db, photoRow({ event_id: event.id, device_id: device.id }))),
    );
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(5);
    expect(results.filter((r) => r.outcome === "limit")).toHaveLength(15);
  });

  it("a concurrent duplicate intent creates one row", async () => {
    const { event, device } = await setup();
    const photo = photoRow({ event_id: event.id, device_id: device.id });
    const results = await Promise.all([
      insertPhotoIfUnderLimit(db, photo),
      insertPhotoIfUnderLimit(db, { ...photo, id: newId() }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["created", "existing"]);
    expect(results[0].photo?.id).toBe(results[1].photo?.id);
  });
});

describe("photos: storing, publishing and rejecting", () => {
  async function pending() {
    const ctx = await setup();
    const photo = photoRow({ event_id: ctx.event.id, device_id: ctx.device.id });
    await insertPhotoIfUnderLimit(db, photo);
    return { ...ctx, photo };
  }

  it("publishes only once both variants are stored", async () => {
    const { photo } = await pending();
    await markVariantStored(db, photo.id, "hd").run();
    expect((await publishPhotoIfComplete(db, photo.id, NOW).run()).meta.changes).toBe(0);
    await markVariantStored(db, photo.id, "thumb").run();
    expect((await publishPhotoIfComplete(db, photo.id, NOW).run()).meta.changes).toBe(1);
    expect(await getPhoto(db, photo.id)).toMatchObject({
      state: "READY",
      thumb_stored: 1,
      hd_stored: 1,
      published_at: NOW.toISOString(),
    });
    // Publishing again changes nothing (a concurrent duplicate PUT).
    expect((await publishPhotoIfComplete(db, photo.id, new Date()).run()).meta.changes).toBe(0);
    expect((await getPhoto(db, photo.id))?.published_at).toBe(NOW.toISOString());
  });

  it("never publishes into a deleted event", async () => {
    const { event, photo } = await pending();
    await db.batch([markVariantStored(db, photo.id, "thumb"), markVariantStored(db, photo.id, "hd")]);
    await db.prepare("UPDATE events SET deleted_at = ?, purge_after = ? WHERE id = ?").bind(T0, T0, event.id).run();
    expect((await publishPhotoIfComplete(db, photo.id, NOW).run()).meta.changes).toBe(0);
    expect((await getPhoto(db, photo.id))?.state).toBe("PENDING");
  });

  it("rejects a PENDING photo with a reason, once", async () => {
    const { photo } = await pending();
    expect((await rejectPhoto(db, photo.id, "app1_segment").run()).meta.changes).toBe(1);
    expect(await getPhoto(db, photo.id)).toMatchObject({ state: "REJECTED", reject_reason: "app1_segment" });
    expect((await rejectPhoto(db, photo.id, "other").run()).meta.changes).toBe(0);
    // A REJECTED photo can't be published, even with both flags set.
    await db.batch([markVariantStored(db, photo.id, "thumb"), markVariantStored(db, photo.id, "hd")]);
    expect((await publishPhotoIfComplete(db, photo.id, NOW).run()).meta.changes).toBe(0);
  });

  it("hides, unhides and deletes only within the given event", async () => {
    const { event, photo } = await pending();
    const other = eventRow();
    await insertEvent(db, other).run();
    expect((await setPhotoHidden(db, other.id, photo.id, true).run()).meta.changes).toBe(0);
    expect((await setPhotoHidden(db, event.id, photo.id, true).run()).meta.changes).toBe(1);
    expect((await getPhoto(db, photo.id))?.hidden).toBe(1);
    await setPhotoHidden(db, event.id, photo.id, false).run();
    expect((await getPhoto(db, photo.id))?.hidden).toBe(0);
    expect((await deletePhoto(db, other.id, photo.id).run()).meta.changes).toBe(0);
    expect((await deletePhoto(db, event.id, photo.id).run()).meta.changes).toBe(1);
    expect(await getPhoto(db, photo.id)).toBeNull();
  });
});

describe("photos: the gallery page", () => {
  async function readyPhotos(eventId: string, deviceId: string, count: number, sessionId = "s-1") {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const photo = photoRow({ event_id: eventId, device_id: deviceId, session_id: sessionId, shot: i });
      await insertPhotoIfUnderLimit(db, photo);
      // Pairs share a published_at, so the id tie-break is exercised.
      const at = new Date(Date.parse(T0) + Math.floor(i / 2) * 1000);
      await db.batch([
        markVariantStored(db, photo.id, "thumb"),
        markVariantStored(db, photo.id, "hd"),
        publishPhotoIfComplete(db, photo.id, at),
      ]);
      ids.push(photo.id);
    }
    return ids;
  }

  it("pages READY, visible photos newest first with a stable cursor", async () => {
    const { event, device } = await setup();
    await readyPhotos(event.id, device.id, 7);
    const all = await db
      .prepare("SELECT id FROM photos ORDER BY published_at DESC, id DESC")
      .all<{ id: string }>();
    const expected = all.results.map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listGalleryPage(db, { eventId: event.id, cursor: cursor ? decodeCursor(cursor) : null, limit: 3 });
      seen.push(...page.photos.map((p) => p.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  it("a deep page reads about one page of rows, not everything before it (D1 bills rows read)", async () => {
    const { event, device } = await setup();
    await readyPhotos(event.id, device.id, 40);
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      cursor = (await listGalleryPage(db, { eventId: event.id, cursor: cursor ? decodeCursor(cursor) : null, limit: 3 })).nextCursor;
    }
    const page = await listGalleryPage(db, { eventId: event.id, cursor: decodeCursor(cursor!), limit: 3 });
    expect(page.photos).toHaveLength(3);
    expect(page.rowsRead).toBeLessThanOrEqual(5);
  });

  it("returns the fields the gallery needs", async () => {
    const { event, device } = await setup();
    const [id] = await readyPhotos(event.id, device.id, 1);
    const page = await listGalleryPage(db, { eventId: event.id, cursor: null, limit: 24 });
    expect(page).toEqual({
      photos: [{ id, session_id: "s-1", shot: 0, width: 2560, height: 1707, published_at: T0 }],
      nextCursor: null,
      rowsRead: expect.any(Number),
    });
  });

  it("excludes hidden, PENDING, REJECTED and other events' photos", async () => {
    const { event, device } = await setup();
    const other = eventRow();
    await insertEvent(db, other).run();
    const [visible, hidden] = await readyPhotos(event.id, device.id, 2);
    await setPhotoHidden(db, event.id, hidden!, true).run();
    await readyPhotos(other.id, device.id, 2);
    await insertPhotoIfUnderLimit(db, photoRow({ event_id: event.id, device_id: device.id }));
    const rejected = photoRow({ event_id: event.id, device_id: device.id });
    await insertPhotoIfUnderLimit(db, rejected);
    await rejectPhoto(db, rejected.id, "bad").run();

    const page = await listGalleryPage(db, { eventId: event.id, cursor: null, limit: 24 });
    expect(page.photos.map((p) => p.id)).toEqual([visible]);
  });

  it("filters by session within the event", async () => {
    const { event, device } = await setup();
    const mine = await readyPhotos(event.id, device.id, 2, "mine");
    await readyPhotos(event.id, device.id, 2, "theirs");
    const page = await listGalleryPage(db, { eventId: event.id, sessionId: "mine", cursor: null, limit: 24 });
    expect(page.photos.map((p) => p.id).sort()).toEqual([...mine].sort());
  });
});

describe("audit", () => {
  it("round-trips entries, newest first, optionally by event", async () => {
    const eventId = newId();
    const first = { id: newId(), at: "2026-10-22T09:00:00.000Z", actor: "a@example.com", action: "event.create", event_id: eventId, target_id: eventId, detail: { name: "x" } };
    const second = { id: newId(), at: "2026-10-22T09:05:00.000Z", actor: "a@example.com", action: "device.create", event_id: null, target_id: "d", detail: null };
    await db.batch([insertAudit(db, first), insertAudit(db, second)]);
    expect(await listAudit(db, { limit: 10 })).toEqual([second, first]);
    expect(await listAudit(db, { eventId, limit: 10 })).toEqual([first]);
    expect(await listAudit(db, { limit: 1 })).toEqual([second]);
  });
});

describe("audit with a device write", () => {
  const entry = (deviceId: string) => ({
    id: newId(NOW),
    at: NOW.toISOString(),
    actor: "admin@example.com",
    action: "device.revoke",
    event_id: null,
    target_id: deviceId,
    detail: null,
  });

  it("writes the row only while the device exists and isn't revoked", async () => {
    const active = deviceRow();
    const revoked = deviceRow({ revoked_at: T0 });
    await db.batch([insertDevice(db, active), insertDevice(db, revoked)]);
    const [audit, update] = await db.batch([insertAuditIfDeviceActive(db, entry(active.id), active.id), revokeDevice(db, active.id, NOW)]);
    expect([audit?.meta.changes, update?.meta.changes]).toEqual([1, 1]);
    const [again, noop] = await db.batch([insertAuditIfDeviceActive(db, entry(active.id), active.id), revokeDevice(db, active.id, NOW)]);
    expect([again?.meta.changes, noop?.meta.changes]).toEqual([0, 0]);
    expect((await insertAuditIfDeviceActive(db, entry(revoked.id), revoked.id).run()).meta.changes).toBe(0);
    const missing = newId();
    expect((await insertAuditIfDeviceActive(db, entry(missing), missing).run()).meta.changes).toBe(0);
    expect((await listAudit(db, { limit: 10 })).map((a) => a.target_id)).toEqual([active.id]);
  });

  it("records an enrolment as the device itself, and nothing for a failed one", async () => {
    const device = deviceRow();
    await insertDevice(db, device).run();
    await setEnrolCode(db, device.id, "c".repeat(64), "2026-10-22T10:10:00.000Z").run();
    const args = { name: "Booth 1", appVersion: "1.2.3", now: NOW };
    const enrol = (codeHash: string, tokenHash: string) =>
      db.batch([
        redeemEnrolCode(db, { ...args, codeHash, tokenHash }),
        insertEnrolAudit(db, { id: newId(NOW), at: NOW.toISOString(), tokenHash, detail: { appVersion: "1.2.3" } }),
      ]);

    const [redeemed, audit] = await enrol("c".repeat(64), "t".repeat(64));
    expect(redeemed?.results).toHaveLength(1);
    expect(audit?.meta.changes).toBe(1);
    const [failed, none] = await enrol("c".repeat(64), "u".repeat(64));
    expect(failed?.results).toHaveLength(0);
    expect(none?.meta.changes).toBe(0);
    expect(await listAudit(db, { limit: 10 })).toEqual([
      {
        id: expect.any(String),
        at: NOW.toISOString(),
        actor: `device:${device.id}`,
        action: "device.enrol",
        event_id: null,
        target_id: device.id,
        detail: { appVersion: "1.2.3" },
      },
    ]);
  });
});

describe("audit with an event write", () => {
  const entry = (eventId: string) => ({
    id: newId(), at: NOW.toISOString(), actor: "a@example.com", action: "event.update", event_id: eventId, target_id: null, detail: { fields: ["name"] },
  });

  it("writes the row and the change together while the event is at the read version", async () => {
    const { event } = await setup();
    const next = { ...event, name: "Renamed", updated_at: NOW.toISOString() };
    const [audit, update] = await db.batch([insertAuditIfEventAt(db, entry(event.id), event.id, event.updated_at), updateEvent(db, next, event.updated_at)]);
    expect(audit?.meta.changes).toBe(1);
    expect(update?.meta.changes).toBe(1);
    expect(await listAudit(db, { eventId: event.id, limit: 10 })).toHaveLength(1);
  });

  it("writes neither when another write got there first (no audit row for a change that didn't happen)", async () => {
    const { event } = await setup();
    await updateEvent(db, { ...event, name: "Theirs", updated_at: NOW.toISOString() }, event.updated_at).run();
    const mine = { ...event, name: "Mine", updated_at: new Date(NOW.getTime() + 1).toISOString() };
    const [audit, update] = await db.batch([insertAuditIfEventAt(db, entry(event.id), event.id, event.updated_at), updateEvent(db, mine, event.updated_at)]);
    expect(audit?.meta.changes).toBe(0);
    expect(update?.meta.changes).toBe(0);
    expect(await listAudit(db, { eventId: event.id, limit: 10 })).toEqual([]);
    expect((await getEvent(db, event.id))?.name).toBe("Theirs");
  });
});

async function makeReady(eventId: string, deviceId: string, count: number, sessionId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const photo = photoRow({ event_id: eventId, device_id: deviceId, session_id: sessionId, shot: i });
    await insertPhotoIfUnderLimit(db, photo);
    await db.batch([markVariantStored(db, photo.id, "thumb"), markVariantStored(db, photo.id, "hd"), publishPhotoIfComplete(db, photo.id, NOW)]);
    ids.push(photo.id);
  }
  return ids;
}

describe("countPhotos", () => {
  it("counts by state and hidden, per event, for one event or all", async () => {
    const { event, device } = await setup();
    const other = eventRow();
    await insertEvent(db, other).run();
    const empty = eventRow();
    await insertEvent(db, empty).run();
    await makeReady(event.id, device.id, 3, "s");
    const pending = photoRow({ event_id: event.id, device_id: device.id });
    const rejected = photoRow({ event_id: event.id, device_id: device.id });
    await insertPhotoIfUnderLimit(db, pending);
    await insertPhotoIfUnderLimit(db, rejected);
    await rejectPhoto(db, rejected.id, "bad").run();
    const [hiddenOne] = await makeReady(event.id, device.id, 1, "h");
    await setPhotoHidden(db, event.id, hiddenOne!, true).run();
    await makeReady(other.id, device.id, 2, "o");

    const all = await countPhotos(db);
    expect(all.get(event.id)).toEqual({ pending: 1, ready: 4, rejected: 1, hidden: 1 });
    expect(all.get(other.id)).toEqual({ pending: 0, ready: 2, rejected: 0, hidden: 0 });
    expect(all.get(empty.id)).toBeUndefined();
    const one = await countPhotos(db, event.id);
    expect([...one.keys()]).toEqual([event.id]);
    expect(one.get(event.id)).toEqual({ pending: 1, ready: 4, rejected: 1, hidden: 1 });
  });
});
