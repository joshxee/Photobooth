// The daily retention job (DESIGN §14, D15; session 16). There is no photo expiry: photos stay until
// an admin deletes the event. This job only
//   1. purges deleted events once their 7-day undo has run out: the whole `events/{id}/` prefix in
//      R2 (READY photos, variants that never became READY, late writes), then the event row (its
//      photo rows cascade) with one audit row;
//   2. prunes audit rows older than 90 days.
// Each step is idempotent and the run is bounded (domain/retention.ts RETENTION_LIMITS), so anything
// unfinished is picked up by the next day's run: an event stays deleted until its prefix is empty.
//
// No object can arrive after the undo: from the deletion on, an upload for the event is refused, and
// an upload URL lives 15 minutes, so by `purge_after` (7 days later) nothing is in flight. The final
// write still checks the event is deleted and due, so a restore that sneaks in is kept.
import { insertAudit, insertPurgeAuditIfDue, pruneAudit } from "../db/audit";
import { deleteEventIfPurgeDue, listDeletedEvents } from "../db/events";
import { newId } from "../domain/ids";
import { eventPrefix } from "../domain/media";
import { auditCutoff, dueForPurge, RETENTION_LIMITS, RunBudget } from "../domain/retention";
import { log } from "../lib/log";
import { VERSION } from "../lib/version";

export interface RetentionSummary {
  purgedEvents: number;
  /** Due events that are not finished (budget used up, or a failure): they continue next run. */
  pendingEvents: number;
  deletedObjects: number;
  prunedAudit: number;
  failures: number;
  /** D1 and R2 calls made. */
  subrequests: number;
}

type Bindings = Pick<Env, "DB" | "MEDIA">;

/** How many deleted events one run reads. Oldest purge_after first, so the due ones lead. */
const DELETED_EVENTS_READ = 100;

export async function runRetention(env: Bindings, now: Date): Promise<RetentionSummary> {
  const started = Date.now();
  const budget = new RunBudget();
  const summary: RetentionSummary = { purgedEvents: 0, pendingEvents: 0, deletedObjects: 0, prunedAudit: 0, failures: 0, subrequests: 0 };

  await purgeDeletedEvents(env, now, budget, summary);
  await pruneOldAudit(env, now, budget, summary);

  summary.subrequests = budget.subrequests;
  log.info({ outcome: "retention_run", version: VERSION, ...summary, durationMs: Date.now() - started });
  return summary;
}

async function purgeDeletedEvents(env: Bindings, now: Date, budget: RunBudget, summary: RetentionSummary): Promise<void> {
  budget.spend();
  const due = dueForPurge(await listDeletedEvents(env.DB, DELETED_EVENTS_READ), now);

  for (const event of due) {
    if (!budget.canStartEvent() || !budget.canPurgePage()) {
      summary.pendingEvents++;
      continue;
    }
    budget.eventStarted();
    try {
      const outcome = await purgeEvent(env, event.id, now, budget);
      summary.deletedObjects += outcome.deleted;
      if (outcome.state === "purged") {
        summary.purgedEvents++;
        log.info({ outcome: "retention_event_purged", eventId: event.id, deletedObjects: outcome.deleted });
      } else if (outcome.state === "restored") {
        // Restored after the run read it (the admin API refuses a restore past the undo, so this is
        // a clock edge). Its objects are gone; the event stays, and is not purged again.
        log.warn({ outcome: "retention_event_restored", eventId: event.id, deletedObjects: outcome.deleted });
      } else {
        summary.pendingEvents++;
      }
    } catch (err) {
      // Whatever was deleted stays deleted, and the event stays deleted, so the next run resumes.
      // The error's name only: a message may carry a key or URL.
      summary.failures++;
      summary.pendingEvents++;
      log.error({ outcome: "retention_event_failed", eventId: event.id, errorName: err instanceof Error ? err.name : "unknown" });
    }
  }
}

/**
 * Deletes the event's objects page by page, then its row. `pending` means the object budget ran out
 * first; `restored` that the final write found the event no longer deleted (nothing was written).
 */
async function purgeEvent(
  env: Bindings,
  eventId: string,
  now: Date,
  budget: RunBudget,
): Promise<{ deleted: number; state: "purged" | "pending" | "restored" }> {
  let deleted = 0;
  const prefix = eventPrefix(eventId);
  for (;;) {
    if (!budget.canPurgePage()) return { deleted, state: "pending" };
    budget.spend();
    const page = await env.MEDIA.list({ prefix, limit: budget.pageSize() });
    if (page.objects.length > 0) {
      budget.spend();
      await env.MEDIA.delete(page.objects.map((o) => o.key));
      budget.pageDeleted(page.objects.length);
      deleted += page.objects.length;
    }
    if (!page.truncated) break;
  }

  // The prefix is empty. The audit row and the event's removal are one atomic batch, both guarded
  // by "still deleted and past the undo"; a change count above 0 (cascaded photo rows may add to it) says the event went.
  budget.spend();
  const results = await env.DB.batch([
    insertPurgeAuditIfDue(env.DB, { id: newId(now), at: now.toISOString() }, eventId),
    deleteEventIfPurgeDue(env.DB, eventId, now),
  ]);
  return { deleted, state: (results[1]?.meta.changes ?? 0) > 0 ? "purged" : "restored" };
}

async function pruneOldAudit(env: Bindings, now: Date, budget: RunBudget, summary: RetentionSummary): Promise<void> {
  const cutoff = auditCutoff(now);
  const { auditRowsPerStatement: rows, auditStatements } = RETENTION_LIMITS;
  let pruned = 0;
  try {
    for (let i = 0; i < auditStatements && budget.canSpend(1); i++) {
      budget.spend();
      const { meta } = await pruneAudit(env.DB, cutoff, rows).run();
      pruned += meta.changes;
      if (meta.changes < rows) break;
    }
    summary.prunedAudit = pruned;
    if (pruned > 0 && budget.canSpend(1)) {
      budget.spend();
      await insertAudit(env.DB, {
        id: newId(now),
        at: now.toISOString(),
        actor: "system",
        action: "audit.prune",
        event_id: null,
        target_id: null,
        detail: { rows: pruned, olderThan: cutoff },
      }).run();
    }
  } catch (err) {
    summary.prunedAudit = pruned;
    summary.failures++;
    log.error({ outcome: "retention_prune_failed", errorName: err instanceof Error ? err.name : "unknown" });
  }
}
