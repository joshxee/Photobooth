import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { deviceRow, eventRow, photoRow, resetDb } from "../test/factories";
import { insertDevice } from "./devices";
import { insertEvent } from "./events";
import { insertPhotoIfUnderLimit } from "./photos";

const db = env.DB;

async function columns(table: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).bind(table).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function indexColumns(index: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).bind(index).all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Runs a raw insert and returns the error message, or null if it succeeded. */
async function failure(sql: string, ...params: unknown[]): Promise<string | null> {
  try {
    await db.prepare(sql).bind(...params).run();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

beforeEach(resetDb);

describe("0001_init: columns match DESIGN §6", () => {
  it("events", async () => {
    expect(await columns("events")).toEqual([
      "id", "public_id", "name", "venue", "timezone", "starts_at", "ends_at",
      "upload_status", "gallery_status", "share_token", "access_version", "photo_limit",
      "retention_until", "deleted_at", "purge_after", "created_at", "updated_at",
    ]);
  });

  it("devices", async () => {
    expect(await columns("devices")).toEqual([
      "id", "name", "token_hash", "enrol_code_hash", "enrol_expires_at", "enrolled_at", "revoked_at",
      "last_seen_at", "last_backlog", "app_version",
    ]);
  });

  it("photos", async () => {
    expect(await columns("photos")).toEqual([
      "id", "event_id", "device_id", "client_photo_id", "session_id", "shot", "captured_at",
      "thumb_sha256", "hd_sha256", "thumb_stored", "hd_stored", "state", "reject_reason", "hidden",
      "width", "height", "variant_bytes", "published_at", "created_at",
    ]);
  });

  it("audit", async () => {
    expect(await columns("audit")).toEqual(["id", "at", "actor", "action", "event_id", "target_id", "detail"]);
  });

  it("has the indexes from DESIGN §6", async () => {
    expect(await indexColumns("photos_gallery")).toEqual(["event_id", "state", "hidden", "published_at", "id"]);
    expect(await indexColumns("photos_session")).toEqual(["event_id", "session_id"]);
    expect(await indexColumns("audit_event_at")).toEqual(["event_id", "at"]);
    expect(await indexColumns("audit_at")).toEqual(["at"]);
  });

  it("the gallery page query uses the gallery index", async () => {
    const { results } = await db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM photos WHERE event_id = ? AND state = 'READY' AND hidden = 0
         ORDER BY published_at DESC, id DESC LIMIT 25`,
      )
      .bind("e")
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toContain("photos_gallery");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});

describe("0001_init: constraints", () => {
  it("rejects an unknown upload_status, gallery_status and photo state", async () => {
    const event = eventRow();
    await insertEvent(db, event).run();
    expect(await failure(`UPDATE events SET upload_status = 'PAUSED' WHERE id = ?`, event.id)).toMatch(/CHECK/);
    expect(await failure(`UPDATE events SET gallery_status = 'PUBLIC' WHERE id = ?`, event.id)).toMatch(/CHECK/);

    const device = deviceRow();
    await insertDevice(db, device).run();
    const photo = photoRow({ event_id: event.id, device_id: device.id });
    await insertPhotoIfUnderLimit(db, photo);
    expect(await failure(`UPDATE photos SET state = 'DONE' WHERE id = ?`, photo.id)).toMatch(/CHECK/);
    expect(await failure(`UPDATE photos SET hidden = 2 WHERE id = ?`, photo.id)).toMatch(/CHECK/);
  });

  it("keeps deleted_at and purge_after together", async () => {
    const event = eventRow();
    await insertEvent(db, event).run();
    expect(await failure(`UPDATE events SET deleted_at = ? WHERE id = ?`, "2026-10-22T00:00:00.000Z", event.id)).toMatch(/CHECK/);
  });

  it("only allows READY with both variants stored and a published_at", async () => {
    const event = eventRow();
    const device = deviceRow();
    await insertEvent(db, event).run();
    await insertDevice(db, device).run();
    const photo = photoRow({ event_id: event.id, device_id: device.id });
    await insertPhotoIfUnderLimit(db, photo);
    const at = "2026-10-22T00:00:00.000Z";
    expect(await failure(`UPDATE photos SET state = 'READY', published_at = ?, thumb_stored = 1 WHERE id = ?`, at, photo.id)).toMatch(/CHECK/);
    expect(await failure(`UPDATE photos SET state = 'READY', thumb_stored = 1, hd_stored = 1 WHERE id = ?`, photo.id)).toMatch(/CHECK/);
    expect(await failure(`UPDATE photos SET state = 'REJECTED' WHERE id = ?`, photo.id)).toMatch(/CHECK/);
  });

  it("rejects a photo for an unknown event or device (foreign keys are on)", async () => {
    const event = eventRow();
    await insertEvent(db, event).run();
    const photo = photoRow({ event_id: event.id, device_id: "no-such-device" });
    const sql = `INSERT INTO photos (id, event_id, device_id, client_photo_id, session_id, shot, captured_at,
      thumb_sha256, hd_sha256, width, height, variant_bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    expect(
      await failure(sql, photo.id, photo.event_id, photo.device_id, photo.client_photo_id, photo.session_id, photo.shot,
        photo.captured_at, photo.thumb_sha256, photo.hd_sha256, photo.width, photo.height, JSON.stringify(photo.variant_bytes), photo.created_at),
    ).toMatch(/FOREIGN KEY/);
  });

  it("purging an event row removes its photos", async () => {
    const event = eventRow();
    const device = deviceRow();
    await insertEvent(db, event).run();
    await insertDevice(db, device).run();
    await insertPhotoIfUnderLimit(db, photoRow({ event_id: event.id, device_id: device.id }));
    await db.prepare(`DELETE FROM events WHERE id = ?`).bind(event.id).run();
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM photos`).first<number>("n");
    expect(left).toBe(0);
  });

  it("rejects a malformed sha256", async () => {
    const event = eventRow();
    const device = deviceRow();
    await insertEvent(db, event).run();
    await insertDevice(db, device).run();
    const photo = photoRow({ event_id: event.id, device_id: device.id });
    await insertPhotoIfUnderLimit(db, photo);
    expect(await failure(`UPDATE photos SET hd_sha256 = 'abc' WHERE id = ?`, photo.id)).toMatch(/CHECK/);
  });
});
