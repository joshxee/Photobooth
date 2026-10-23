# 16 — Retention and deletion (scheduled job)

**Goal:** the daily scheduled job purges deleted events after their 7-day undo and prunes the
audit log. It is idempotent, resumable within Worker limits, and observable.

> **D15 (2026-10-22):** photos no longer expire. `uploads_until` (`ends_at` + 90 days, was
> `retention_until`) only closes uploads, which the intent route already enforces, so this job
> has no expiry purge. Only deleted events are purged.

- **Depends on:** 06, 11.
- **Unlocks:** 17.
- **Device check:** n/a.

## Read first
- DESIGN.md §7 (storage table), §9.2 (partial failure and late writes), §14 (retention
  table), §15 (logs), §16 (Workers Free).
- Cloudflare docs: Cron Triggers, R2 `list` and `delete` (batch delete up to 1,000 keys),
  Worker limits for scheduled handlers. On Workers Free a cron invocation gets 10 ms CPU and
  1,000 subrequests to Cloudflare services.

## Scope
1. **`domain/retention.ts`**, pure: given now, decide which deleted events are due
   (`isPurgeDue` in `domain/eventState.ts`: `purge_after <= now`) and not yet purged.
2. **`scheduled()` handler:**
   - Deleted events past `purge_after`: purge the R2 prefix `events/{eventId}/` in pages of up
     to 1,000 keys. When the prefix is empty, delete the event row (its photo rows go with it,
     `ON DELETE CASCADE`) or mark it `purged_at` via an additive migration 0002, whichever
     keeps the audit trail clearer. Write an audit row.
   - Audit rows older than 90 days: delete in batches.
   - Variants of photos that never became READY live under the same event prefix, so the purge
     removes them too. There is no `incoming/` prefix or lifecycle rule (DESIGN D6).
   - Work budget per run (a maximum number of keys or events), sized for Workers Free: 10 ms
     CPU and 1,000 R2/D1 calls per invocation. Measure the CPU of a full-budget run on staging
     with `wrangler tail --format json` and record it. Anything unfinished continues the next
     day, and each step is idempotent. Log a structured summary line.
3. **Admin visibility:** event detail shows "Uploads close on" (`uploads_until`) and, for deleted
   events, "Purges on".
   Restore is disabled after the purge. Update the 14 UI minimally.
4. **Tests** (Vitest, invoking `scheduled` directly; Local Explorer can also trigger it in dev):
   - the purge boundary (`purge_after`), and an event past `uploads_until` that is not purged;
   - a deleted event restored before the purge is not purged;
   - a purge across more than 1,000 objects resumes over runs;
   - a late variant write after deletion is caught by the prefix delete;
   - the audit prune;
   - idempotent re-run.

## Out of scope
- Photo expiry (D15), reminder emails, SD-card custody (an operator process).

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test
bunx wrangler dev --test-scheduled   # curl "http://localhost:8787/__scheduled?cron=0+14+*+*+*" with seeded deleted events; check R2/D1 in Local Explorer
```

## Done when
- [x] Every row in DESIGN §14 that the system enforces has a test.
- [x] A purge of more than 1,000 objects is proven to resume across runs.
- [x] No migration was needed (the event row is deleted; the audit row is the trail).
- [ ] (open, needs staging: session 07/17) A full-budget run's CPU on staging is recorded and under the Workers Free 10 ms, or the
      budget is reduced until it is.

## Hand-off
- `wiki/Portal.md`: the retention design (why prefix delete makes late writes and stray
  variants harmless, the work budget and its measured CPU, what is *not* automatic: SD cards).
- PROGRESS.md entry.

