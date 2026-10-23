// Retention rules and the work budget of the daily job (DESIGN §14, D15). Pure: no I/O, `now` is
// passed in. There is no photo expiry: only a deleted event, once its 7-day undo has passed, is
// purged, and the audit log is pruned after 90 days. See jobs/retention.ts for the I/O.
import { type EventState, isPurgeDue } from "./eventState";

export const AUDIT_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Audit rows with `at` before this are pruned (`at` text compares as time, DESIGN §6). */
export function auditCutoff(now: Date): string {
  return new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS).toISOString();
}

/**
 * The deleted events whose undo has run out, oldest `purge_after` first (ties by ID), so a backlog
 * after a failed run drains in order. A restored event has no `deleted_at` and is never returned.
 */
export function dueForPurge<E extends Pick<EventState, "deleted_at" | "purge_after"> & { id: string }>(events: readonly E[], now: Date): E[] {
  return events
    .filter((e) => isPurgeDue(e, now))
    .sort((a, b) => Date.parse(a.purge_after as string) - Date.parse(b.purge_after as string) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * What one run may do. Workers Free gives a cron invocation 10 ms of CPU and 50 subrequests (every
 * D1 and R2 call counts), so the job does a small, bounded amount and the rest waits for the next
 * day; each step is idempotent. The CPU these numbers cost is measured on staging (wiki/Portal.md).
 */
export const RETENTION_LIMITS = {
  /** Calls to D1 and R2 in one run. Free allows 50; the rest is headroom for the runtime. */
  subrequests: 40,
  /** Kept back for the audit prune so a purge backlog can't starve it. */
  pruneReserve: 4,
  /** Objects a run may delete. R2's CPU cost is per key (listing and deleting), so this, not a page count, is the bound. */
  objects: 2000,
  /** R2 batch delete takes at most 1,000 keys. */
  keysPerPage: 1000,
  /** Events a run may start. */
  events: 10,
  /** Audit rows per DELETE, and DELETEs per run. */
  auditRowsPerStatement: 500,
  auditStatements: 3,
} as const;

export class RunBudget {
  private used = 0;
  private objects = 0;
  private events = 0;

  constructor(private readonly limits: typeof RETENTION_LIMITS = RETENTION_LIMITS) {}

  /** Calls to Cloudflare services so far. */
  get subrequests(): number {
    return this.used;
  }

  spend(calls = 1): void {
    this.used += calls;
  }

  canSpend(calls: number): boolean {
    return this.used + calls <= this.limits.subrequests;
  }

  canStartEvent(): boolean {
    return this.events < this.limits.events;
  }

  eventStarted(): void {
    this.events++;
  }

  /** Another page may be deleted: object budget left, and list + delete + the event's final write still fit after the prune's reserve. */
  canPurgePage(): boolean {
    return this.objects < this.limits.objects && this.used + 3 + this.limits.pruneReserve <= this.limits.subrequests;
  }

  /** How many keys the next list may ask for. */
  pageSize(): number {
    return Math.min(this.limits.keysPerPage, this.limits.objects - this.objects);
  }

  pageDeleted(keys: number): void {
    this.objects += keys;
  }
}
