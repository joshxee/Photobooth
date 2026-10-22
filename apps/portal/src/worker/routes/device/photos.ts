// POST /v1/device/photos on the gallery host (DESIGN §9.1, §9.2): the upload intent. A booth
// declares a photo and its two booth-made variants (D14) and gets back the photo's state, with a
// signed upload URL for each variant not yet stored. Idempotent on (device, clientPhotoId).
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { LIMITS, PhotoIntentRequest, PhotoIntentResponse, type UploadDescriptor, type Variant } from "../../../shared/schemas";
import { getEvent } from "../../db/events";
import { getPhoto, getPhotoByClientId, insertPhotoIfUnderLimit, type PhotoRow, publishPhotoIfComplete } from "../../db/photos";
import { acceptsUploads, isDeleted } from "../../domain/eventState";
import { newId } from "../../domain/ids";
import { readBody } from "../../lib/api";
import { AppError, errorResponse } from "../../lib/errors";
import { originOf } from "../../lib/hosts";
import { hmacUploadSigner, type UploadSigner } from "../../lib/uploadUrl";
import { addLogIds } from "../../middleware/accessLog";
import { deviceAuth } from "../../middleware/deviceAuth";
import type { AppEnv } from "../../types";

/** The request is about 450 bytes. */
const MAX_BODY_BYTES = 4 * 1024;
/** The limiter's period (wrangler.jsonc, INTENT_LIMITER), sent as Retry-After. */
const LIMIT_PERIOD_SECONDS = 60;
const VARIANTS: readonly Variant[] = ["thumb", "hd"];

/**
 * Per device, after authentication (so the key is a device ID, never an IP). 120 a minute is
 * twice what the booth's two upload workers need when draining a backlog (wiki/Portal.md).
 */
const intentRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { success } = await c.env.INTENT_LIMITER.limit({ key: c.get("device").id });
  if (success) return next();
  const res = errorResponse(c, "rate_limited", "Too many upload intents. Wait a minute and try again.");
  res.headers.set("Retry-After", String(LIMIT_PERIOD_SECONDS));
  return res;
});

/** A retried intent must declare exactly what was accepted the first time. */
function sameDeclaration(photo: PhotoRow, body: PhotoIntentRequest): boolean {
  return (
    photo.event_id === body.eventId &&
    photo.thumb_sha256 === body.variants.thumb.sha256 &&
    photo.hd_sha256 === body.variants.hd.sha256 &&
    photo.variant_bytes.thumb === body.variants.thumb.bytes &&
    photo.variant_bytes.hd === body.variants.hd.bytes &&
    photo.width === body.width &&
    photo.height === body.height
  );
}

const CONFLICT = "This clientPhotoId was already used with different variants or another event.";

async function respond(db: D1Database, signer: UploadSigner, photo: PhotoRow, now: Date): Promise<PhotoIntentResponse> {
  // Both variants stored but not READY: the event was deleted between a variant's checks and its
  // publish, then restored. Publishing now is the same conditional UPDATE the PUT runs.
  if (photo.state === "PENDING" && photo.thumb_stored === 1 && photo.hd_stored === 1) {
    await publishPhotoIfComplete(db, photo.id, now).run();
    photo = (await getPhoto(db, photo.id)) ?? photo;
  }
  if (photo.state === "READY") return { state: "READY", photoId: photo.id };
  if (photo.state === "REJECTED") return { state: "REJECTED", photoId: photo.id, reason: photo.reject_reason ?? "rejected" };

  const uploads: { thumb?: UploadDescriptor; hd?: UploadDescriptor } = {};
  for (const variant of VARIANTS) {
    if (photo[`${variant}_stored`] === 1) continue;
    const sha256 = variant === "thumb" ? photo.thumb_sha256 : photo.hd_sha256;
    uploads[variant] = await signer.sign({ photoId: photo.id, variant, bytes: photo.variant_bytes[variant], sha256 }, now);
  }
  // Still PENDING with nothing left to upload means the publish was refused (a deleted event):
  // a 500 makes the booth retry later instead of reading a state the contract can't express.
  if (!uploads.thumb && !uploads.hd) throw new Error("photo stored but not publishable");
  return { state: "PENDING", photoId: photo.id, uploads };
}

export const devicePhotosApi = new Hono<AppEnv>();

devicePhotosApi.use(deviceAuth());

devicePhotosApi.post("/", intentRateLimit, bodyLimit({ maxSize: MAX_BODY_BYTES }), async (c) => {
  const body = await readBody(c, PhotoIntentRequest);
  if (body.variants.thumb.bytes > LIMITS.thumbMaxBytes || body.variants.hd.bytes > LIMITS.hdMaxBytes) {
    throw new AppError("too_large", `A thumb may be at most ${LIMITS.thumbMaxBytes} bytes and an hd ${LIMITS.hdMaxBytes}.`);
  }
  const db = c.env.DB;
  const device = c.get("device");
  const now = new Date();
  addLogIds(c, { eventId: body.eventId });

  const event = await getEvent(db, body.eventId);
  if (!event) throw new AppError("not_found", "No such event.");
  if (isDeleted(event)) throw new AppError("event_closed", "The event was deleted.");

  let photo: PhotoRow;
  if (acceptsUploads(event, now)) {
    const inserted = await insertPhotoIfUnderLimit(db, {
      id: newId(now),
      event_id: body.eventId,
      device_id: device.id,
      client_photo_id: body.clientPhotoId,
      session_id: body.sessionId,
      shot: body.shot,
      captured_at: body.capturedAt,
      thumb_sha256: body.variants.thumb.sha256,
      hd_sha256: body.variants.hd.sha256,
      width: body.width,
      height: body.height,
      variant_bytes: { thumb: body.variants.thumb.bytes, hd: body.variants.hd.bytes },
      created_at: now.toISOString(),
    });
    if (inserted.outcome === "limit") throw new AppError("photo_limit", "The event has reached its photo limit.");
    photo = inserted.photo;
  } else {
    // Closing blocks new intents only (DESIGN §9.2): an accepted photo's re-intent is how the
    // booth gets fresh URLs after upload_expired, so it is answered with the photo's state.
    const existing = await getPhotoByClientId(db, device.id, body.clientPhotoId);
    if (!existing) throw new AppError("event_closed", "The event is not accepting uploads.");
    photo = existing;
  }
  if (!sameDeclaration(photo, body)) throw new AppError("conflict", CONFLICT);
  addLogIds(c, { photoId: photo.id });

  const signer = hmacUploadSigner(c.env.UPLOAD_KEY, originOf(c.env.GALLERY_HOST));
  return c.json(PhotoIntentResponse.parse(await respond(db, signer, photo, now)));
});
