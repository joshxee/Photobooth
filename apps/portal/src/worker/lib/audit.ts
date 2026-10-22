// Building audit rows for admin mutations (DESIGN §12). The SQL is in db/audit.ts; every route
// puts the row in the same `db.batch` as its change, so a change is never left unaudited.
import type { Context } from "hono";
import type { AuditEntry } from "../db/audit";
import { newId } from "../domain/ids";
import type { AppEnv } from "../types";

export interface AuditFields {
  action: string;
  eventId: string | null;
  targetId?: string | null;
  /** Never a secret: a rotation records the new access version, not the token. */
  detail?: Record<string, unknown> | null;
}

/** The audit row for this request's actor (set by adminAuth), at `now`. */
export function auditEntry(c: Context<AppEnv>, now: Date, f: AuditFields): AuditEntry {
  return {
    id: newId(now),
    at: now.toISOString(),
    actor: c.get("actor"),
    action: f.action,
    event_id: f.eventId,
    target_id: f.targetId ?? null,
    detail: f.detail ?? null,
  };
}
