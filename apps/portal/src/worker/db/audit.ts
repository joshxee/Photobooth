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

/** Newest first, optionally for one event. */
export async function listAudit(db: D1Database, args: { eventId?: string; limit: number }): Promise<AuditEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT id, at, actor, action, event_id, target_id, detail FROM audit
       WHERE ?1 IS NULL OR event_id = ?1
       ORDER BY at DESC, id DESC LIMIT ?2`,
    )
    .bind(args.eventId ?? null, args.limit)
    .all<StoredEntry>();
  return results.map((r) => ({ ...r, detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>) }));
}
