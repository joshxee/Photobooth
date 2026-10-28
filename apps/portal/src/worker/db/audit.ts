// `audit` table (DESIGN §6, §12). `detail` is JSON and must never hold a secret: a rotation
// records that it happened, not the token.

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  event_id: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
}

type StoredEntry = Omit<AuditEntry, "detail"> & { detail: string | null };

export function insertAudit(db: D1Database, a: AuditEntry): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit (id, at, actor, action, event_id, target_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(a.id, a.at, a.actor, a.action, a.event_id, a.target_id, a.detail === null ? null : JSON.stringify(a.detail));
}

/**
 * Newest first, optionally for one event and/or one action; `cursor` is the position of the last
 * row of the previous page. The SQL is assembled from fixed fragments (values are always bound)
 * rather than `? IS NULL OR …`, so the event filter uses `audit_event_at` and the unfiltered list
 * `audit_at` (see listGalleryPage). The caller asks for one row more than a page to know whether
 * there is another.
 */
export async function listAudit(
  db: D1Database,
  args: { eventId?: string; action?: string; cursor?: { at: string; id: string }; limit: number },
): Promise<AuditEntry[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (args.eventId !== undefined) {
    where.push("event_id = ?");
    params.push(args.eventId);
  }
  if (args.action !== undefined) {
    where.push("action = ?");
    params.push(args.action);
  }
  if (args.cursor) {
    where.push("(at, id) < (?, ?)");
    params.push(args.cursor.at, args.cursor.id);
  }
  params.push(args.limit);
  const { results } = await db
    .prepare(
      `SELECT id, at, actor, action, event_id, target_id, detail FROM audit
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .bind(...params)
    .all<StoredEntry>();
  return results.map((r) => ({ ...r, detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>) }));
}

/**
 * The audit row for a photo write that only applies to a photo that exists (delete). Put it
 * **before** the write in the same `db.batch`, so a delete that finds no row (already gone) leaves
 * no audit row behind.
 */
export function insertAuditIfPhotoExists(db: D1Database, a: AuditEntry, photoId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit (id, at, actor, action, event_id, target_id, detail)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM photos WHERE id = ?)`,
    )
    .bind(a.id, a.at, a.actor, a.action, a.event_id, a.target_id, a.detail === null ? null : JSON.stringify(a.detail), photoId);
}

/**
 * The audit row for hiding (`hiddenNow` false) or unhiding (true) a photo: it applies only while
 * the photo is in that state. Put it **before** `setPhotoHidden` in the same `db.batch`, so either
 * both apply or neither does, and a repeat leaves no audit row.
 */
export function insertAuditIfPhotoHidden(db: D1Database, a: AuditEntry, photoId: string, hiddenNow: boolean): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit (id, at, actor, action, event_id, target_id, detail)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM photos WHERE id = ? AND hidden = ?)`,
    )
    .bind(a.id, a.at, a.actor, a.action, a.event_id, a.target_id, a.detail === null ? null : JSON.stringify(a.detail), photoId, hiddenNow ? 1 : 0);
}

/**
 * The audit row for a device write that only applies to an existing, unrevoked device (re-issue a
 * code, revoke). Put it **before** the write in the same `db.batch`, so a write that matches no
 * row (unknown or already revoked) leaves no audit row behind.
 */
export function insertAuditIfDeviceActive(db: D1Database, a: AuditEntry, deviceId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit (id, at, actor, action, event_id, target_id, detail)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL)`,
    )
    .bind(a.id, a.at, a.actor, a.action, a.event_id, a.target_id, a.detail === null ? null : JSON.stringify(a.detail), deviceId);
}

/**
 * The audit row for an enrolment, written by the device itself (actor `device:<id>`). Put it
 * **after** `redeemEnrolCode` in the same `db.batch`: it finds the device by its new credential
 * hash, so a refused code writes nothing. `detail` must not hold the code or the credential.
 */
export function insertEnrolAudit(
  db: D1Database,
  a: { id: string; at: string; tokenHash: string; detail: Record<string, unknown> },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit (id, at, actor, action, event_id, target_id, detail)
       SELECT ?, ?, 'device:' || id, 'device.enrol', NULL, id, ? FROM devices WHERE token_hash = ?`,
    )
    .bind(a.id, a.at, JSON.stringify(a.detail), a.tokenHash);
}

/**
 * The audit row for an event write guarded by `updateEvent(db, next, readAt)`. Put it **before**
 * that update in the same `db.batch`: both see the event at `readAt`, so either both apply or
 * neither does, and a write that lost the optimistic check leaves no audit row behind.
 */
export function insertAuditIfEventAt(db: D1Database, a: AuditEntry, eventId: string, readAt: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit (id, at, actor, action, event_id, target_id, detail)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE id = ? AND updated_at = ?)`,
    )
    .bind(a.id, a.at, a.actor, a.action, a.event_id, a.target_id, a.detail === null ? null : JSON.stringify(a.detail), eventId, readAt);
}

/**
 * The audit row for an event's purge, written by the retention job (actor `system`). It records the
 * event's name and how many photo rows it had, since the event row is deleted right after it. Put it
 * **before** `deleteEventIfPurgeDue` in the same `db.batch`: both match the event only while it is
 * still deleted and past its undo, so a restored event leaves no audit row. No tokens or URLs.
 */
export function insertPurgeAuditIfDue(db: D1Database, a: { id: string; at: string }, eventId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit (id, at, actor, action, event_id, target_id, detail)
       SELECT ?1, ?2, 'system', 'event.purge', id, id,
              json_object('name', name, 'photos', (SELECT COUNT(*) FROM photos WHERE event_id = events.id))
       FROM events WHERE id = ?3 AND deleted_at IS NOT NULL AND purge_after <= ?2`,
    )
    .bind(a.id, a.at, eventId);
}

/**
 * Deletes up to `rows` of the oldest audit rows with `at` before `cutoff` (the `audit_at` index
 * orders them). Run it until `meta.changes < rows`; a repeat is harmless.
 */
export function pruneAudit(db: D1Database, cutoff: string, rows: number): D1PreparedStatement {
  return db.prepare("DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE at < ? ORDER BY at LIMIT ?)").bind(cutoff, rows);
}
