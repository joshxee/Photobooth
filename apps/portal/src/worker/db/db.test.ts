import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeCursor } from "../domain/cursor";
import { applyEventAction } from "../domain/eventState";
import { newId } from "../domain/ids";
import { deviceRow, eventRow, photoRow, resetDb, T0 } from "../test/factories";
import { insertAudit, listAudit } from "./audit";
import {
  getDevice,
  getDeviceByTokenHash,
  insertDevice,
  listDevices,
  redeemEnrolCode,
  revokeDevice,
  setEnrolCode,
} from "./devices";
import { getEvent, getEventByPublicId, insertEvent, listEvents, listOpenEvents, updateEvent } from "./events";
import {
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
    expect(await getEventByPublicId(db, event.public_id)).toEqual(event);
    expect(await getEvent(db, "missing")).toBeNull();
  });

  it("lists every event (deleted included) for admins, newest start first", async () => {
    const older = eventRow({ starts_at: "2026-01-01T00:00:00.000Z", ends_at: "2026-01-01T06:00:00.000Z" });
    const newer = eventRow({ deleted_at: T0, purge_after: "2026-10-29T09:00:00.000Z" });
    await db.batch([insertEvent(db, older), insertEvent(db, newer)]);
    expect((await listEvents(db)).map((e) => e.id)).toEqual([newer.id, older.id]);
  });

  it("lists OPEN, non-deleted, unexpired events for booths", async () => {
    const open = eventRow({ upload_status: "OPEN" });
    const rows = [
      open,
      eventRow({ upload_status: "CLOSED" }),
      eventRow({ upload_status: "DRAFT" }),
      eventRow({ upload_status: "OPEN", deleted_at: T0, purge_after: "2026-10-29T09:00:00.000Z" }),
      eventRow({ upload_status: "OPEN", retention_until: "2026-10-22T10:00:00.000Z" }),
    ];
    await db.batch(rows.map((r) => insertEvent(db, r)));
    expect((await listOpenEvents(db, NOW)).map((e) => e.id)).toEqual([open.id]);
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

  it("redeems an unexpired enrolment code exactly once", async () => {
    const device = deviceRow();
    await insertDevice(db, device).run();
    await setEnrolCode(db, device.id, "c".repeat(64), "2026-10-22T10:10:00.000Z").run();

    const enrolled = await redeemEnrolCode(db, { codeHash: "c".repeat(64), tokenHash: "t".repeat(64), appVersion: "1.2.3", now: NOW });
    expect(enrolled).toMatchObject({
      id: device.id,
      token_hash: "t".repeat(64),
      enrolled_at: NOW.toISOString(),
      app_version: "1.2.3",
      enrol_code_hash: null,
      enrol_expires_at: null,
    });
    expect(await getDeviceByTokenHash(db, "t".repeat(64))).toEqual(enrolled);
    // Single use.
    expect(await redeemEnrolCode(db, { codeHash: "c".repeat(64), tokenHash: "u".repeat(64), appVersion: "1", now: NOW })).toBeNull();
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
      expect(await redeemEnrolCode(db, { codeHash, tokenHash: "t".repeat(64), appVersion: "1", now: NOW })).toBeNull();
    }
  });

  it("re-issuing a code replaces the old one", async () => {
    const device = deviceRow();
    await insertDevice(db, device).run();
    await setEnrolCode(db, device.id, "1".repeat(64), "2026-10-22T10:10:00.000Z").run();
    await setEnrolCode(db, device.id, "2".repeat(64), "2026-10-22T10:10:00.000Z").run();
    expect(await redeemEnrolCode(db, { codeHash: "1".repeat(64), tokenHash: "t".repeat(64), appVersion: "1", now: NOW })).toBeNull();
    expect(await redeemEnrolCode(db, { codeHash: "2".repeat(64), tokenHash: "t".repeat(64), appVersion: "1", now: NOW })).not.toBeNull();
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
