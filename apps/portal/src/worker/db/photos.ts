// `photos` table (DESIGN §6, §9.1, §9.2, §11).
import type { CursorPosition } from "../domain/cursor";
import { encodeCursor } from "../domain/cursor";

export type PhotoState = "PENDING" | "READY" | "REJECTED";
export type Variant = "thumb" | "hd";
export interface VariantBytes {
  thumb: number;
  hd: number;
}

/** What an intent supplies; the rest of the row takes its defaults. */
export interface NewPhoto {
  id: string;
  event_id: string;
  device_id: string;
  client_photo_id: string;
  session_id: string;
  shot: number;
  captured_at: string;
  thumb_sha256: string;
  hd_sha256: string;
  width: number;
  height: number;
  variant_bytes: VariantBytes;
  created_at: string;
}

export interface PhotoRow extends NewPhoto {
  thumb_stored: 0 | 1;
  hd_stored: 0 | 1;
  state: PhotoState;
  reject_reason: string | null;
  hidden: 0 | 1;
  published_at: string | null;
}

const COLUMNS =
  "id, event_id, device_id, client_photo_id, session_id, shot, captured_at, thumb_sha256, hd_sha256, " +
  "thumb_stored, hd_stored, state, reject_reason, hidden, width, height, variant_bytes, published_at, created_at";

type StoredRow = Omit<PhotoRow, "variant_bytes"> & { variant_bytes: string };

function fromStored(row: StoredRow): PhotoRow {
  return { ...row, variant_bytes: JSON.parse(row.variant_bytes) as VariantBytes };
}

/** Fixed column names per variant, so no caller value is ever spliced into SQL. */
const STORED_COLUMN: Record<Variant, string> = { thumb: "thumb_stored", hd: "hd_stored" };

export type InsertResult =
  | { outcome: "created"; photo: PhotoRow }
  /** Same device + clientPhotoId already exists; the caller compares hashes and event (409 conflict). */
  | { outcome: "existing"; photo: PhotoRow }
  /** The event is at its photo_limit (or doesn't exist; the route checks the event first). */
  | { outcome: "limit"; photo: null };

/**
 * The atomic photo-limit insert (DESIGN §6). One statement counts and inserts, so two
 * concurrent intents at limit − 1 can't both get in, and ON CONFLICT makes a retried intent a
 * no-op. The re-select runs in the same batch (one transaction), so it sees that outcome.
 */
export async function insertPhotoIfUnderLimit(db: D1Database, p: NewPhoto): Promise<InsertResult> {
  const [insert, select] = await db.batch<StoredRow>([
    db
      .prepare(
        `INSERT INTO photos (id, event_id, device_id, client_photo_id, session_id, shot, captured_at,
           thumb_sha256, hd_sha256, width, height, variant_bytes, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
         WHERE (SELECT COUNT(*) FROM photos WHERE event_id = ?2) < (SELECT photo_limit FROM events WHERE id = ?2)
         ON CONFLICT (device_id, client_photo_id) DO NOTHING`,
      )
      .bind(
        p.id, p.event_id, p.device_id, p.client_photo_id, p.session_id, p.shot, p.captured_at,
        p.thumb_sha256, p.hd_sha256, p.width, p.height, JSON.stringify(p.variant_bytes), p.created_at,
      ),
    db
      .prepare(`SELECT ${COLUMNS} FROM photos WHERE device_id = ? AND client_photo_id = ?`)
      .bind(p.device_id, p.client_photo_id),
  ]);
  const row = select?.results[0];
  if (insert?.meta.changes === 1 && row) return { outcome: "created", photo: fromStored(row) };
  if (row) return { outcome: "existing", photo: fromStored(row) };
  return { outcome: "limit", photo: null };
}

export async function getPhoto(db: D1Database, id: string): Promise<PhotoRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM photos WHERE id = ?`).bind(id).first<StoredRow>();
  return row ? fromStored(row) : null;
}

/** After a variant's sha256 put and header check pass. Only while PENDING. */
export function markVariantStored(db: D1Database, id: string, variant: Variant): D1PreparedStatement {
  return db.prepare(`UPDATE photos SET ${STORED_COLUMN[variant]} = 1 WHERE id = ? AND state = 'PENDING'`).bind(id);
}

/**
 * PENDING → READY once both variants are stored and the event isn't deleted (DESIGN §9.1).
 * `meta.changes` is 1 for exactly one caller, so concurrent duplicate PUTs publish once.
 */
export function publishPhotoIfComplete(db: D1Database, id: string, now: Date): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE photos SET state = 'READY', published_at = ?
       WHERE id = ? AND state = 'PENDING' AND thumb_stored = 1 AND hd_stored = 1
         AND EXISTS (SELECT 1 FROM events WHERE events.id = photos.event_id AND events.deleted_at IS NULL)`,
    )
    .bind(now.toISOString(), id);
}

/** PENDING → REJECTED with the header walk's reason. A REJECTED photo never becomes READY. */
export function rejectPhoto(db: D1Database, id: string, reason: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE photos SET state = 'REJECTED', reject_reason = ? WHERE id = ? AND state = 'PENDING'`)
    .bind(reason, id);
}

/** Scoped by event: a photo ID from another event changes nothing. */
export function setPhotoHidden(db: D1Database, eventId: string, id: string, hidden: boolean): D1PreparedStatement {
  return db.prepare(`UPDATE photos SET hidden = ? WHERE id = ? AND event_id = ?`).bind(hidden ? 1 : 0, id, eventId);
}

/** Hard delete of the row (the caller deletes the R2 objects). Scoped by event. */
export function deletePhoto(db: D1Database, eventId: string, id: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM photos WHERE id = ? AND event_id = ?`).bind(id, eventId);
}

export type GalleryPhoto = Pick<PhotoRow, "id" | "session_id" | "shot" | "width" | "height"> & { published_at: string };

/**
 * One page of READY, visible photos, newest first. Fetches one extra row to know whether there
 * is a next page. `limit` is validated by the route (1–100).
 *
 * The SQL is assembled from fixed fragments (values are always bound) rather than written as
 * `?x IS NULL OR …`, because that form stops SQLite seeking the `photos_gallery` index to the
 * cursor: a deep page then reads every row before it, and D1 bills rows read. `rowsRead` is
 * returned so tests (and logs) can see that cost.
 */
export async function listGalleryPage(
  db: D1Database,
  args: { eventId: string; sessionId?: string; cursor: CursorPosition | null; limit: number },
): Promise<{ photos: GalleryPhoto[]; nextCursor: string | null; rowsRead: number }> {
  const where = ["event_id = ?", "state = 'READY'", "hidden = 0"];
  const params: (string | number)[] = [args.eventId];
  if (args.sessionId !== undefined) {
    where.push("session_id = ?");
    params.push(args.sessionId);
  }
  if (args.cursor) {
    where.push("(published_at, id) < (?, ?)");
    params.push(args.cursor.publishedAt, args.cursor.id);
  }
  params.push(args.limit + 1);
  const { results, meta } = await db
    .prepare(
      `SELECT id, session_id, shot, width, height, published_at FROM photos
       WHERE ${where.join(" AND ")}
       ORDER BY published_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all<GalleryPhoto>();
  const photos = results.slice(0, args.limit);
  const last = photos.at(-1);
  const nextCursor = results.length > args.limit && last ? encodeCursor({ publishedAt: last.published_at, id: last.id }) : null;
  return { photos, nextCursor, rowsRead: meta.rows_read };
}
