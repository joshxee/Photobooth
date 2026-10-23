// `events` table (DESIGN §6). Prepared statements only. Writes return the statement so a route
// can run it alone or in one `db.batch` with its audit row.
import type { EventState } from "../domain/eventState";

export interface EventRow extends EventState {
  id: string;
  public_id: string;
  name: string;
  venue: string;
  timezone: string;
  starts_at: string;
  ends_at: string;
  photo_limit: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, public_id, name, venue, timezone, starts_at, ends_at, upload_status, gallery_status, share_token, " +
  "access_version, photo_limit, uploads_until, deleted_at, purge_after, created_at, updated_at";

export function insertEvent(db: D1Database, e: EventRow): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      e.id, e.public_id, e.name, e.venue, e.timezone, e.starts_at, e.ends_at, e.upload_status, e.gallery_status,
      e.share_token, e.access_version, e.photo_limit, e.uploads_until, e.deleted_at, e.purge_after,
      e.created_at, e.updated_at,
    );
}

export function getEvent(db: D1Database, id: string): Promise<EventRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM events WHERE id = ?`).bind(id).first<EventRow>();
}

/** The guest routes' lookup (one row, by the UNIQUE index), with the rows D1 read for the access log. */
export async function getEventByPublicId(db: D1Database, publicId: string): Promise<{ event: EventRow | null; rowsRead: number }> {
  const { results, meta } = await db.prepare(`SELECT ${COLUMNS} FROM events WHERE public_id = ?`).bind(publicId).all<EventRow>();
  return { event: results[0] ?? null, rowsRead: meta.rows_read };
}

/** Admin list: every event, deleted ones included (they can be restored), newest start first. */
export async function listEvents(db: D1Database): Promise<EventRow[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM events ORDER BY starts_at DESC, id DESC`).all<EventRow>();
  return results;
}

/** The device events response holds at most this many (DeviceEventsResponse). */
export const OPEN_EVENTS_MAX = 100;

/** Booth list: events that accept uploads now (domain `acceptsUploads`), soonest start first. */
export async function listOpenEvents(db: D1Database, now: Date): Promise<EventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM events
       WHERE upload_status = 'OPEN' AND deleted_at IS NULL AND uploads_until > ?
       ORDER BY starts_at, id LIMIT ?`,
    )
    .bind(now.toISOString(), OPEN_EVENTS_MAX)
    .all<EventRow>();
  return results;
}

/**
 * Writes every mutable column of `e`, only if the row still has `readAt` as its updated_at
 * (optimistic concurrency: two admins acting on the same read can't both win). `meta.changes`
 * is 0 when the row changed underneath or doesn't exist. id, public_id and created_at never change.
 */
export function updateEvent(db: D1Database, e: EventRow, readAt: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE events SET name = ?, venue = ?, timezone = ?, starts_at = ?, ends_at = ?, upload_status = ?,
         gallery_status = ?, share_token = ?, access_version = ?, photo_limit = ?, uploads_until = ?,
         deleted_at = ?, purge_after = ?, updated_at = ?
       WHERE id = ? AND updated_at = ?`,
    )
    .bind(
      e.name, e.venue, e.timezone, e.starts_at, e.ends_at, e.upload_status, e.gallery_status, e.share_token,
      e.access_version, e.photo_limit, e.uploads_until, e.deleted_at, e.purge_after, e.updated_at,
      e.id, readAt,
    );
}

/** What the retention job needs to know about a deleted event. */
export interface DeletedEvent {
  id: string;
  deleted_at: string;
  purge_after: string;
}

/**
 * Soft-deleted events, oldest `purge_after` first (domain `dueForPurge` decides which are due).
 * Few at a time: an admin deletes an event by hand and it goes after 7 days. The LIMIT only bounds a
 * backlog after a long outage; the oldest, which are the due ones, come first.
 */
export async function listDeletedEvents(db: D1Database, limit: number): Promise<DeletedEvent[]> {
  const { results } = await db
    .prepare("SELECT id, deleted_at, purge_after FROM events WHERE deleted_at IS NOT NULL ORDER BY purge_after, id LIMIT ?")
    .bind(limit)
    .all<DeletedEvent>();
  return results;
}

/**
 * Removes a purged event's row (its photo rows go with it, `ON DELETE CASCADE`), but only while it is
 * still deleted and past its undo: an event restored in the meantime is kept. Put the audit row
 * (`insertPurgeAuditIfDue`) **before** it in the same `db.batch`; the batch is atomic.
 */
export function deleteEventIfPurgeDue(db: D1Database, eventId: string, now: Date): D1PreparedStatement {
  return db.prepare("DELETE FROM events WHERE id = ? AND deleted_at IS NOT NULL AND purge_after <= ?").bind(eventId, now.toISOString());
}
