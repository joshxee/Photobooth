// GET /v1/device/events and /v1/device/events/{id} on the gallery host (DESIGN §8), behind
// deviceAuth. The booth's event picker and the post-shoot QR (session 13) read these.
import { Hono } from "hono";
import { DeviceEventDetail, DeviceEventsResponse, Id } from "../../../shared/schemas";
import { type EventRow, getEvent, listOpenEvents } from "../../db/events";
import { acceptsUploads, galleryVisible, isDeleted, localDate, type UploadStatus } from "../../domain/eventState";
import { AppError } from "../../lib/errors";
import { galleryUrl } from "../../lib/hosts";
import { deviceAuth } from "../../middleware/deviceAuth";
import type { AppEnv } from "../../types";

function summary(e: EventRow) {
  return { id: e.id, name: e.name, venue: e.venue, timezone: e.timezone, localDate: localDate(e.starts_at, e.timezone) };
}

/**
 * The upload status as the booth should act on it: an OPEN event past `uploads_until` takes no
 * more photos (D15), so it reads as CLOSED.
 */
function effectiveUploadStatus(e: EventRow, now: Date): UploadStatus {
  return e.upload_status === "OPEN" && !acceptsUploads(e, now) ? "CLOSED" : e.upload_status;
}

export const deviceEventsApi = new Hono<AppEnv>();

deviceEventsApi.use(deviceAuth());

/** Events a booth can upload to now: OPEN, not deleted, inside the upload window. */
deviceEventsApi.get("/", async (c) => {
  const events = await listOpenEvents(c.env.DB, new Date());
  return c.json(DeviceEventsResponse.parse({ events: events.map(summary) }));
});

/**
 * Any event that isn't deleted (a CLOSED event's QR is still useful), with the gallery URL and its
 * `#k=` token only while the gallery is LIVE.
 */
deviceEventsApi.get("/:id", async (c) => {
  const id = Id.safeParse(c.req.param("id"));
  const event = id.success ? await getEvent(c.env.DB, id.data) : null;
  if (!event || isDeleted(event)) throw new AppError("not_found", "No such event.");
  return c.json(
    DeviceEventDetail.parse({
      ...summary(event),
      uploadStatus: effectiveUploadStatus(event, new Date()),
      galleryStatus: event.gallery_status,
      galleryUrl: galleryVisible(event) ? galleryUrl(c.env, event) : null,
    }),
  );
});
