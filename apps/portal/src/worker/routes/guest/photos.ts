// GET /e/{publicId}/api/photos?cursor&session&limit on the gallery host (DESIGN §11), behind
// guestAuth. The gallery's grid, its polling (30 s while the event is OPEN) and the post-shoot
// session view (10 s for 2 minutes) all read this, so it must stay cheap: one event row (guestAuth)
// and one keyset query over the `photos_gallery` index, about one page of rows.
import { Hono } from "hono";
import { GalleryPhotosPage, GalleryPhotosQuery } from "../../../shared/schemas";
import { listGalleryPage } from "../../db/photos";
import { decodeCursor } from "../../domain/cursor";
import { acceptsUploads, localDate } from "../../domain/eventState";
import { AppError } from "../../lib/errors";
import { addRowsRead } from "../../middleware/accessLog";
import { guestAuth } from "../../middleware/guestAuth";
import type { AppEnv } from "../../types";

export const guestPhotosApi = new Hono<AppEnv>();

guestPhotosApi.use(guestAuth());

/**
 * READY, non-hidden photos of this event only, newest first. `session` filters within the event, so
 * another event's session ID gives an empty page. A bad query is a 400: the cookie already proved
 * access, so it tells the caller nothing new.
 */
guestPhotosApi.get("/", async (c) => {
  const query = GalleryPhotosQuery.parse(c.req.query());
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) throw new AppError("invalid_request", "The cursor is not valid.");

  const event = c.get("guestEvent");
  const page = await listGalleryPage(c.env.DB, { eventId: event.id, sessionId: query.session, cursor, limit: query.limit });
  addRowsRead(c, page.rowsRead);
  return c.json(
    GalleryPhotosPage.parse({
      eventName: event.name,
      localDate: localDate(event.starts_at, event.timezone),
      // Drives polling: new photos can arrive only while the booth may still upload.
      eventOpen: acceptsUploads(event, new Date()),
      photos: page.photos.map((p) => ({
        id: p.id,
        sessionId: p.session_id,
        shot: p.shot,
        width: p.width,
        height: p.height,
        publishedAt: p.published_at,
      })),
      nextCursor: page.nextCursor,
      contact: { address: c.env.CONTACT_ADDRESS, email: c.env.CONTACT_EMAIL },
    }),
  );
});
