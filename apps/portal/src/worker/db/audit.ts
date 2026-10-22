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
 * Newest first, optionally for one event. Two fixed statements rather than `? IS NULL OR …`,
 * so each uses its index (`audit_event_at` or `audit_at`); see listGalleryPage.
 */
export async function listAudit(db: D1Database, args: { eventId?: string; limit: number }): Promise<AuditEntry[]> {
  const columns = "SELECT id, at, actor, action, event_id, target_id, detail FROM audit";
  const statement =
    args.eventId === undefined
      ? db.prepare(`${columns} ORDER BY at DESC, id DESC LIMIT ?`).bind(args.limit)
      : db.prepare(`${columns} WHERE event_id = ? ORDER BY at DESC, id DESC LIMIT ?`).bind(args.eventId, args.limit);
  const { results } = await statement.all<StoredEntry>();
  return results.map((r) => ({ ...r, detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>) }));
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
