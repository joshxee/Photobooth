// PUT /v1/device/uploads/{photoId}/{variant}?exp&sig on the gallery host (DESIGN §9.1, §13). One
// variant's bytes, authorised by the signed URL alone: no bearer, so the route can later become a
// presigned R2 URL without a booth release (§9.4). The body is streamed into R2 with the declared
// sha256 (R2 refuses a mismatch and stores nothing), then processPhoto checks and publishes.
import { Hono } from "hono";
import { Id, UploadResponse, Variant } from "../../../shared/schemas";
import { getDevice } from "../../db/devices";
import { getEvent } from "../../db/events";
import { getPhoto } from "../../db/photos";
import { isDeleted } from "../../domain/eventState";
import { variantKey } from "../../domain/media";
import { processPhoto } from "../../domain/processPhoto";
import { AppError } from "../../lib/errors";
import { verifyUploadUrl } from "../../lib/uploadUrl";
import { addLogIds } from "../../middleware/accessLog";
import type { AppEnv } from "../../types";

/** An unknown photo gets the same answer as a bad signature: the URL proves nothing either way. */
const NOT_VALID = "The upload URL is not valid.";

/** R2's error for a body that doesn't match the `sha256` option (spike RESULTS.md, Q1). */
function isHashMismatch(err: unknown): boolean {
  return err instanceof Error && err.message.includes("(10037)");
}

/** `image/jpeg`, parameters ignored, case-insensitive. */
function isJpeg(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "image/jpeg";
}

export const deviceUploadsApi = new Hono<AppEnv>();

deviceUploadsApi.put("/:photoId/:variant", async (c) => {
  const photoId = Id.safeParse(c.req.param("photoId"));
  const variant = Variant.safeParse(c.req.param("variant"));
  if (!photoId.success || !variant.success) throw new AppError("not_found", "Not found.");
  const db = c.env.DB;
  const now = new Date();

  // 1. The URL: signed for this photo's declared bytes and hash, and not expired.
  const photo = await getPhoto(db, photoId.data);
  if (!photo) throw new AppError("forbidden", NOT_VALID);
  const bytes = photo.variant_bytes[variant.data];
  const sha256 = variant.data === "thumb" ? photo.thumb_sha256 : photo.hd_sha256;
  const verdict = await verifyUploadUrl(
    c.env.UPLOAD_KEY,
    { photoId: photo.id, variant: variant.data, bytes, sha256 },
    { exp: c.req.query("exp"), sig: c.req.query("sig") },
    now,
  );
  if (verdict === "invalid") throw new AppError("forbidden", NOT_VALID);
  if (verdict === "expired") throw new AppError("upload_expired", "The upload URL has expired.");
  addLogIds(c, { deviceId: photo.device_id, eventId: photo.event_id, photoId: photo.id });

  // 2. A revoked device's URLs stop working at once (§13), and a deleted event takes nothing.
  // Closing uploads does not stop an accepted photo (§9.2), so only deletion is checked here.
  const [device, event] = await Promise.all([getDevice(db, photo.device_id), getEvent(db, photo.event_id)]);
  if (!device || device.revoked_at !== null) throw new AppError("unauthorized", "The device is not enrolled.");
  if (!event || isDeleted(event)) throw new AppError("event_closed", "The event was deleted.");

  // 3. Idempotent: a READY photo is done (a replayed URL writes nothing), a REJECTED one stays so.
  if (photo.state === "READY") return c.json(UploadResponse.parse({ state: "READY", photoId: photo.id }), 201);
  if (photo.state === "REJECTED") throw new AppError("invalid_image", `The image failed validation: ${photo.reject_reason}.`);

  // 4. The body: exactly the declared bytes, as a JPEG, streamed into R2 with the declared hash.
  if (!isJpeg(c.req.header("Content-Type"))) throw new AppError("invalid_request", "Content-Type must be image/jpeg.");
  const length = c.req.header("Content-Length");
  if (length === undefined || !/^[0-9]{1,10}$/.test(length) || Number(length) !== bytes || !c.req.raw.body) {
    throw new AppError("invalid_request", `Content-Length must be the declared ${bytes} bytes.`);
  }
  try {
    await c.env.MEDIA.put(variantKey(photo.event_id, photo.id, variant.data), c.req.raw.body, {
      sha256,
      httpMetadata: { contentType: "image/jpeg" },
    });
  } catch (err) {
    if (isHashMismatch(err)) throw new AppError("hash_mismatch", "The uploaded bytes do not match the declared sha256.");
    throw err;
  }

  // 5. Check the stored object and publish the photo if both variants are in.
  const result = await processPhoto({ db, media: c.env.MEDIA, now: () => new Date() }, photo.id, variant.data);
  switch (result.state) {
    case "READY":
      return c.json(UploadResponse.parse({ state: "READY", photoId: photo.id }), 201);
    case "STORED":
      return c.json(UploadResponse.parse({ state: "STORED", photoId: photo.id, variant: variant.data }), 200);
    case "REJECTED":
      throw new AppError("invalid_image", `The image failed validation: ${result.reason}.`);
    case "NOT_FOUND":
      // An admin deleted the photo between this request's checks and its put: don't leave the object.
      await c.env.MEDIA.delete(variantKey(photo.event_id, photo.id, variant.data));
      throw new AppError("not_found", "The photo was deleted.");
  }
});
