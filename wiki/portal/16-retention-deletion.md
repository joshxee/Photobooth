# 16 — Retention and deletion (scheduled job)

**Goal:** the daily scheduled job enforces 90-day retention and 7-day purge of deleted events,
and prunes the audit log. It is idempotent, resumable within Worker limits, and observable.

- **Depends on:** 06, 11.
- **Unlocks:** 17.
- **Device check:** n/a.

## Read first
- DESIGN.md §7 (lifecycle table), §9.2 (partial failure and late writes), §14 (retention
  table), §15 (logs).
- Cloudflare docs: Cron Triggers, R2 `list` and `delete` (batch delete up to 1,000 keys),
  Worker limits for scheduled handlers (subrequests, CPU).

## Scope
1. **`domain/retention.ts`**, pure: given now, decide which events are expired
   (`retention_until < now`, not yet purged) and which deleted events are due
   (`purge_after < now`).
2. **`scheduled()` handler:**
   - Expired events: mark the gallery expired (access already stops at `retention_until` via
     11's check), then purge the R2 prefix `events/{eventId}/` in pages of up to 1,000 keys.
     When the prefix is empty, delete the photo rows and mark the event `purged_at` (add a
     column via migration 0002, additive). Write an audit row.
   - Deleted events past `purge_after`: the same purge.
   - Audit rows older than 90 days: delete in batches.
   - Stray `incoming/` older than 1 day: rely on the lifecycle rule, but log a count if any are
     found (an early warning that the rule is missing).
   - Work budget per run (a maximum number of keys or events). Anything unfinished continues the
     next day, and each step is idempotent. Log a structured summary line.
3. **Admin visibility:** event detail shows "Expires on" and, for deleted events, "Purges on".
   Restore is disabled after the purge. Update the 14 UI minimally.
4. **Tests** (Vitest, invoking `scheduled` directly; Local Explorer can also trigger it in dev):
   - expiry boundary;
   - a deleted event restored before the purge is not purged;
   - a purge across more than 1,000 objects resumes over runs;
   - a late variant write after deletion is caught by the prefix delete;
   - the audit prune;
   - idempotent re-run.

## Out of scope
- Retention extension, reminder emails, SD-card custody (an operator process).

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test
bunx wrangler dev --test-scheduled   # curl "http://localhost:8787/__scheduled?cron=0+14+*+*+*" with seeded expired/deleted events; check R2/D1 in Local Explorer
```

## Done when
- [ ] Every row in DESIGN §14 that the system enforces has a test.
- [ ] A purge of more than 1,000 objects is proven to resume across runs.
- [ ] Migration 0002 is additive and applied by the staging deploy.

## Hand-off
- `wiki/Portal.md`: the retention design (why prefix delete makes late writes harmless, the
  work budget, what is *not* automatic: SD cards).
- PROGRESS.md entry.

