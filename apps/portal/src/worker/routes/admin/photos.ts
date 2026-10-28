// The admin photo moderation API (DESIGN §8 admin, §12, §14), mounted under /api on the admin host
// behind adminAuth, sameOrigin, the body limit and no-store (routes/admin.ts). Every mutation runs
// its write and its audit row in one `db.batch`, so a photo is never changed unaudited.
import { Hono, type Context } from "hono";
import { AdminPhoto, AdminPhotoList, AdminPhotosQuery, Id, Variant } from "../../../shared/schemas";
import { insertAuditIfPhotoExists, insertAuditIfPhotoHidden } from "../../db/audit";
import { getEvent } from "../../db/events";
import { deletePhoto, getPhoto, listAdminPhotos, type PhotoRow, setPhotoHidden } from "../../db/photos";
import { decodeIdCursor } from "../../domain/cursor";
import { variantKey } from "../../domain/media";
import { auditEntry } from "../../lib/audit";
import { AppError } from "../../lib/errors";
import { log } from "../../lib/log";
import { jpegResponse } from "../../lib/media";
import { addLogIds } from "../../middleware/accessLog";
import type { AppEnv } from "../../types";

/** Never cached anywhere, not even by the admin's own browser: a hidden or deleted photo must not linger. */
const PROXY_CACHE = "private, no-store";

export function toAdminPhoto(p: PhotoRow): AdminPhoto {
  return {
    id: p.id,
    eventId: p.event_id,
    deviceId: p.device_id,
    sessionId: p.session_id,
    shot: p.shot,
    state: p.state,
    rejectReason: p.reject_reason,
    hidden: p.hidden === 1,
    width: p.width,
    height: p.height,
    variantBytes: p.variant_bytes,
    capturedAt: p.captured_at,
    publishedAt: p.published_at,
    createdAt: p.created_at,
  };
}

/** The photo for `:id`, or 404 (a malformed ID is also a 404: it can't name a photo). */
async function loadPhoto(c: Context<AppEnv>): Promise<PhotoRow> {
  const id = Id.safeParse(c.req.param("id"));
  const photo = id.success ? await getPhoto(c.env.DB, id.data) : null;
  if (!photo) throw new AppError("not_found", "No such photo.");
  addLogIds(c, { eventId: photo.event_id, photoId: photo.id });
  return photo;
}

export const photosApi = new Hono<AppEnv>();

photosApi.get("/events/:id/photos", async (c) => {
  const id = Id.safeParse(c.req.param("id"));
  const event = id.success ? await getEvent(c.env.DB, id.data) : null;
  if (!event) throw new AppError("not_found", "No such event.");
  const query = AdminPhotosQuery.parse(c.req.query());
  const cursor = query.cursor === undefined ? null : decodeIdCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) throw new AppError("invalid_request", "The cursor is not valid.");
  const page = await listAdminPhotos(c.env.DB, {
    eventId: event.id,
    state: query.state,
    hidden: query.hidden === undefined ? undefined : query.hidden === "true",
    cursor,
    limit: query.limit,
  });
  return c.json(AdminPhotoList.parse({ photos: page.photos.map(toAdminPhoto), nextCursor: page.nextCursor }));
});

/** Hide (`hidden: true`) or unhide. Guests lose or regain the photo on their next request: nothing is cached server-side. */
function setHidden(hidden: boolean) {
  return async (c: Context<AppEnv>) => {
    const photo = await loadPhoto(c);
    const db = c.env.DB;
    const entry = auditEntry(c, new Date(), {
      action: hidden ? "photo.hide" : "photo.unhide",
      eventId: photo.event_id,
      targetId: photo.id,
      detail: { sessionId: photo.session_id, shot: photo.shot, state: photo.state },
    });
    // Both apply only while the photo is in the other state, so a repeat is a 409 with no audit row.
    const [, update] = await db.batch([insertAuditIfPhotoHidden(db, entry, photo.id, !hidden), setPhotoHidden(db, photo.event_id, photo.id, hidden)]);
    const stored = await getPhoto(db, photo.id);
    if (!stored) throw new AppError("not_found", "No such photo.");
    if (update?.meta.changes !== 1) throw new AppError("conflict", hidden ? "The photo is already hidden." : "The photo isn't hidden.");
    return c.json(AdminPhoto.parse(toAdminPhoto(stored)));
  };
}

photosApi.post("/photos/:id/hide", setHidden(true));
photosApi.post("/photos/:id/unhide", setHidden(false));

/**
 * Permanent delete, for a removal request (DESIGN §14). The objects go first: if R2 fails the row
 * stays, the answer is a 500, and a retry finishes the job; deleting the row first would strand the
 * objects with nothing to find them by. Either variant may be missing (a PENDING or REJECTED photo),
 * and deleting a missing key is not an error. Then the row goes with its audit row in one batch.
 * The row is deleted, not marked: see wiki/Portal.md → "Moderation".
 */
photosApi.delete("/photos/:id", async (c) => {
  const photo = await loadPhoto(c);
  const keys = [variantKey(photo.event_id, photo.id, "thumb"), variantKey(photo.event_id, photo.id, "hd")];
  await c.env.MEDIA.delete(keys);
  const db = c.env.DB;
  const entry = auditEntry(c, new Date(), {
    action: "photo.delete",
    eventId: photo.event_id,
    targetId: photo.id,
    detail: { sessionId: photo.session_id, shot: photo.shot, state: photo.state, hidden: photo.hidden === 1 },
  });
  const [, removed] = await db.batch([insertAuditIfPhotoExists(db, entry, photo.id), deletePhoto(db, photo.event_id, photo.id)]);
  if (removed?.meta.changes !== 1) throw new AppError("not_found", "No such photo.");
  // An upload PUT that landed between the first delete and the row going could have stored an object
  // (a PENDING photo). From here the row is gone, so any later PUT removes its own object (session 06);
  // this sweeps what arrived before. The photo is already deleted, so a failure is logged, not an error.
  try {
    await c.env.MEDIA.delete(keys);
  } catch (err) {
    log.error({ requestId: c.get("requestId"), outcome: "photo_delete_sweep_failed", errorName: err instanceof Error ? err.name : "unknown" });
  }
  return c.json({ id: photo.id });
});

/** The admin's view of any photo in any state, hidden included. Never cached (PROXY_CACHE). */
photosApi.get("/media/:photoId/:variant", async (c) => {
  const id = Id.safeParse(c.req.param("photoId"));
  const variant = Variant.safeParse(c.req.param("variant"));
  if (!id.success || !variant.success) throw new AppError("not_found", "Not found.");
  const photo = await getPhoto(c.env.DB, id.data);
  if (!photo) throw new AppError("not_found", "Not found.");
  addLogIds(c, { eventId: photo.event_id, photoId: photo.id });
  const object = await c.env.MEDIA.get(variantKey(photo.event_id, photo.id, variant.data));
  if (!object) throw new AppError("not_found", "Not found.");
  return jpegResponse(object, { "Cache-Control": PROXY_CACHE });
});
