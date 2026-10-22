// The admin events API (DESIGN §8 admin, §12), mounted under /api on the admin host behind
// adminAuth, sameOrigin, the body limit and no-store (routes/admin.ts). Every mutation runs its
// write and its audit row in one `db.batch`.
import { Hono, type Context } from "hono";
import { AdminEvent, AdminEventList, EventCreateRequest, EventUpdateRequest, Id } from "../../../shared/schemas";
import { insertAudit, insertAuditIfEventAt } from "../../db/audit";
import { type EventRow, getEvent, insertEvent, listEvents, updateEvent } from "../../db/events";
import { countPhotos, type PhotoCounts } from "../../db/photos";
import { type EventAction, applyEventAction, uploadsUntil } from "../../domain/eventState";
import { newId, newPublicId, newShareToken } from "../../domain/ids";
import { readBody } from "../../lib/api";
import { auditEntry } from "../../lib/audit";
import { AppError } from "../../lib/errors";
import { galleryUrl } from "../../lib/hosts";
import type { AppEnv } from "../../types";

const NO_PHOTOS: PhotoCounts = { pending: 0, ready: 0, rejected: 0, hidden: 0 };
const DEFAULT_PHOTO_LIMIT = 2000;

function toAdminEvent(env: Env, e: EventRow, counts: PhotoCounts = NO_PHOTOS): AdminEvent {
  return {
    id: e.id,
    publicId: e.public_id,
    name: e.name,
    venue: e.venue,
    timezone: e.timezone,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    uploadStatus: e.upload_status,
    galleryStatus: e.gallery_status,
    accessVersion: e.access_version,
    photoLimit: e.photo_limit,
    uploadsUntil: e.uploads_until,
    deletedAt: e.deleted_at,
    purgeAfter: e.purge_after,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    galleryUrl: galleryUrl(env, e),
    counts,
  };
}

/** The event for `:id`, or 404 (a malformed ID is also a 404: it can't name an event). */
async function loadEvent(c: Context<AppEnv>): Promise<EventRow> {
  const id = Id.safeParse(c.req.param("id"));
  const event = id.success ? await getEvent(c.env.DB, id.data) : null;
  if (!event) throw new AppError("not_found", "No such event.");
  return event;
}

/** Strictly after the read version, so the optimistic check can't be fooled by a same-millisecond write. */
function nextUpdatedAt(now: Date, readAt: string): string {
  return new Date(Math.max(now.getTime(), Date.parse(readAt) + 1)).toISOString();
}

/** Writes `next` over `read` with its audit row, both or neither; 409 if the row changed meanwhile. */
async function saveEvent(c: Context<AppEnv>, read: EventRow, next: EventRow, now: Date, audit: Parameters<typeof auditEntry>[2]) {
  const db = c.env.DB;
  const entry = auditEntry(c, now, audit);
  const [, update] = await db.batch([insertAuditIfEventAt(db, entry, read.id, read.updated_at), updateEvent(db, next, read.updated_at)]);
  if (update?.meta.changes !== 1) throw new AppError("conflict", "The event changed meanwhile; reload and try again.");
  const counts = (await countPhotos(db, next.id)).get(next.id);
  return c.json(AdminEvent.parse(toAdminEvent(c.env, next, counts)));
}

export const eventsApi = new Hono<AppEnv>();

eventsApi.get("/events", async (c) => {
  const [events, counts] = await Promise.all([listEvents(c.env.DB), countPhotos(c.env.DB)]);
  return c.json(AdminEventList.parse({ events: events.map((e) => toAdminEvent(c.env, e, counts.get(e.id))) }));
});

eventsApi.post("/events", async (c) => {
  const body = await readBody(c, EventCreateRequest);
  const now = new Date();
  const at = now.toISOString();
  const event: EventRow = {
    id: newId(now),
    public_id: newPublicId(),
    name: body.name,
    venue: body.venue ?? "",
    timezone: body.timezone,
    starts_at: body.startsAt,
    ends_at: body.endsAt,
    upload_status: "DRAFT",
    gallery_status: "HIDDEN",
    share_token: newShareToken(),
    access_version: 1,
    photo_limit: body.photoLimit ?? DEFAULT_PHOTO_LIMIT,
    uploads_until: uploadsUntil(body.endsAt),
    deleted_at: null,
    purge_after: null,
    created_at: at,
    updated_at: at,
  };
  const db = c.env.DB;
  const entry = auditEntry(c, now, { action: "event.create", eventId: event.id, detail: { name: event.name } });
  await db.batch([insertEvent(db, event), insertAudit(db, entry)]);
  return c.json(AdminEvent.parse(toAdminEvent(c.env, event)), 201);
});

eventsApi.get("/events/:id", async (c) => {
  const event = await loadEvent(c);
  const counts = (await countPhotos(c.env.DB, event.id)).get(event.id);
  return c.json(AdminEvent.parse(toAdminEvent(c.env, event, counts)));
});

eventsApi.patch("/events/:id", async (c) => {
  const read = await loadEvent(c);
  const body = await readBody(c, EventUpdateRequest);
  if (read.deleted_at !== null) throw new AppError("conflict", "A deleted event can only be restored.");
  const now = new Date();
  const next: EventRow = {
    ...read,
    name: body.name ?? read.name,
    venue: body.venue ?? read.venue,
    timezone: body.timezone ?? read.timezone,
    starts_at: body.startsAt ?? read.starts_at,
    ends_at: body.endsAt ?? read.ends_at,
    photo_limit: body.photoLimit ?? read.photo_limit,
    updated_at: nextUpdatedAt(now, read.updated_at),
  };
  // The schema checks the order only when both times are in the body; this is the merged row.
  if (Date.parse(next.ends_at) < Date.parse(next.starts_at)) throw new AppError("invalid_request", "endsAt is before startsAt.");
  if (next.ends_at !== read.ends_at) next.uploads_until = uploadsUntil(next.ends_at);
  return saveEvent(c, read, next, now, { action: "event.update", eventId: read.id, detail: { fields: Object.keys(body) } });
});

/** The action routes: path segment → state-machine action and audit action. */
const ACTIONS: Record<string, { action: () => EventAction; audit: string }> = {
  open: { action: () => ({ type: "open" }), audit: "event.open" },
  close: { action: () => ({ type: "close" }), audit: "event.close" },
  publish: { action: () => ({ type: "publish" }), audit: "event.publish" },
  suspend: { action: () => ({ type: "suspend" }), audit: "event.suspend" },
  "rotate-link": { action: () => ({ type: "rotate", shareToken: newShareToken() }), audit: "event.rotate_link" },
  delete: { action: () => ({ type: "delete" }), audit: "event.delete" },
  restore: { action: () => ({ type: "restore" }), audit: "event.restore" },
};

eventsApi.post("/events/:id/:action", async (c) => {
  const spec = Object.hasOwn(ACTIONS, c.req.param("action")) ? ACTIONS[c.req.param("action")] : undefined;
  if (!spec) throw new AppError("not_found", "Not found.");
  const read = await loadEvent(c);
  const now = new Date();
  const result = applyEventAction(read, spec.action(), now);
  if (!result.ok) throw new AppError("conflict", "That change isn't allowed in the event's current state.");
  const next: EventRow = { ...read, ...result.next, updated_at: nextUpdatedAt(now, read.updated_at) };
  // Never the token: a rotation records the new access version only.
  const detail =
    spec.audit === "event.rotate_link"
      ? { accessVersion: next.access_version }
      : spec.audit === "event.delete"
        ? { purgeAfter: next.purge_after }
        : null;
  return saveEvent(c, read, next, now, { action: spec.audit, eventId: read.id, detail });
});
