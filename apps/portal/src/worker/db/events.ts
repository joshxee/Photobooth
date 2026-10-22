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

export function getEventByPublicId(db: D1Database, publicId: string): Promise<EventRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM events WHERE public_id = ?`).bind(publicId).first<EventRow>();
}

/** Admin list: every event, deleted ones included (they can be restored), newest start first. */
export async function listEvents(db: D1Database): Promise<EventRow[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM events ORDER BY starts_at DESC, id DESC`).all<EventRow>();
  return results;
}

/** Booth list: events that accept uploads now (domain `acceptsUploads`), soonest start first. */
export async function listOpenEvents(db: D1Database, now: Date): Promise<EventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM events
       WHERE upload_status = 'OPEN' AND deleted_at IS NULL AND uploads_until > ?
       ORDER BY starts_at, id`,
    )
    .bind(now.toISOString())
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
