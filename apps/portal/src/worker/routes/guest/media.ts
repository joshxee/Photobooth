// GET /e/{publicId}/m/{photoId}/{variant}[?download=1] on the gallery host (DESIGN §11 Media, D11):
// 1. guestAuth checks the cookie; 2. it reads the event (LIVE, not deleted, same access_version);
// 3. the photo must be this event's, READY and not hidden; 4. stream the variant from R2. Anything
// else is the generic 404, never cached.
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { Id, Variant } from "../../../shared/schemas";
import { getGalleryPhoto } from "../../db/photos";
import { downloadFilename, variantKey } from "../../domain/media";
import { AppError } from "../../lib/errors";
import { addLogIds, addRowsRead } from "../../middleware/accessLog";
import { guestAuth } from "../../middleware/guestAuth";
import type { AppEnv } from "../../types";

/**
 * A key never changes content (D6: fixed keys, and a READY photo takes no further uploads), so the
 * browser may keep a variant for a year without asking again: every refetch would be a Worker
 * request against the Workers Free daily limit (spike Q12). `private`: no shared cache may keep it.
 */
const MEDIA_CACHE = "private, max-age=31536000, immutable";

/** A refusal must not be cached like the media it stands in for. */
const noStoreUnlessServed = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (c.res.status !== 200) c.res.headers.set("Cache-Control", "no-store");
});

export const guestMediaApi = new Hono<AppEnv>();

guestMediaApi.use(noStoreUnlessServed, guestAuth());

guestMediaApi.get("/:photoId/:variant", async (c) => {
  const photoId = Id.safeParse(c.req.param("photoId"));
  const variant = Variant.safeParse(c.req.param("variant"));
  if (!photoId.success || !variant.success) throw new AppError("not_found", "Not found.");

  const event = c.get("guestEvent");
  const { photo, rowsRead } = await getGalleryPhoto(c.env.DB, event.id, photoId.data);
  addRowsRead(c, rowsRead);
  if (!photo) throw new AppError("not_found", "Not found.");
  addLogIds(c, { photoId: photo.id });

  const object = await c.env.MEDIA.get(variantKey(event.id, photo.id, variant.data));
  if (!object) throw new AppError("not_found", "Not found.");
  const headers = new Headers({
    "Content-Type": "image/jpeg",
    "Content-Length": String(object.size),
    "Cache-Control": MEDIA_CACHE,
  });
  if (c.req.query("download") === "1") {
    headers.set("Content-Disposition", `attachment; filename="${downloadFilename(event.name, photo.session_id, photo.shot)}"`);
  }
  return new Response(object.body, { status: 200, headers });
});
