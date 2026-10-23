import { describe, expect, it } from "vitest";
import { eventPrefix, variantKey } from "./media";
import { AUDIT_RETENTION_DAYS, auditCutoff, dueForPurge, RETENTION_LIMITS, RunBudget } from "./retention";

const NOW = new Date("2026-11-20T14:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function deleted(id: string, purgeAfter: string | null, deletedAt: string | null = purgeAfter === null ? null : "2026-11-01T00:00:00.000Z") {
  return { id, deleted_at: deletedAt, purge_after: purgeAfter };
}

describe("dueForPurge", () => {
  it("keeps events whose purge_after has passed, boundary included, and drops the rest", () => {
    const due = dueForPurge(
      [
        deleted("before", iso(NOW.getTime() - 1)),
        deleted("exactly", NOW.toISOString()),
        deleted("after", iso(NOW.getTime() + 1)),
        deleted("live", null),
      ],
      NOW,
    );
    expect(due.map((e) => e.id)).toEqual(["before", "exactly"]);
  });

  it("orders the oldest purge_after first, ties by ID, so a backlog drains in order", () => {
    const due = dueForPurge(
      [
        deleted("c", "2026-11-10T00:00:00.000Z"),
        deleted("b", "2026-11-05T00:00:00.000Z"),
        deleted("a", "2026-11-05T00:00:00.000Z"),
      ],
      NOW,
    );
    expect(due.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const input = [deleted("b", "2026-11-05T00:00:00.000Z"), deleted("a", "2026-11-01T00:00:00.000Z")];
    dueForPurge(input, NOW);
    expect(input.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

describe("auditCutoff", () => {
  it("is exactly 90 days before now, in toISOString form", () => {
    expect(AUDIT_RETENTION_DAYS).toBe(90);
    expect(auditCutoff(NOW)).toBe("2026-08-22T14:00:00.000Z");
  });
});

describe("eventPrefix", () => {
  it("ends in a slash, so one event's prefix never matches another whose ID starts the same way", () => {
    expect(eventPrefix("019a0000-0000-7000-8000-00000000000a")).toBe("events/019a0000-0000-7000-8000-00000000000a/");
    expect(variantKey("e1", "p1", "hd").startsWith(eventPrefix("e1"))).toBe(true);
    expect(variantKey("e10", "p1", "hd").startsWith(eventPrefix("e1"))).toBe(false);
  });
});

describe("RunBudget", () => {
  it("fits the Workers Free limits with headroom: under 50 subrequests, R2 batch delete at most 1,000 keys", () => {
    expect(RETENTION_LIMITS.subrequests).toBeLessThan(50);
    expect(RETENTION_LIMITS.keysPerPage).toBeLessThanOrEqual(1000);
  });

  it("allows a purge page only while list + delete + the event's final write fit, leaving the prune its reserve", () => {
    const budget = new RunBudget();
    const room = RETENTION_LIMITS.subrequests - RETENTION_LIMITS.pruneReserve;
    budget.spend(room - 3);
    expect(budget.canPurgePage()).toBe(true);
    budget.spend(1);
    expect(budget.canPurgePage()).toBe(false);
  });

  it("allows deleting at most `objects` objects a run, in pages of at most 1,000", () => {
    const budget = new RunBudget();
    expect(budget.pageSize()).toBe(1000);
    budget.spend(2);
    budget.pageDeleted(1000);
    expect(budget.canPurgePage()).toBe(true);
    expect(budget.pageSize()).toBe(1000);
    budget.pageDeleted(900);
    expect(budget.pageSize()).toBe(100);
    budget.pageDeleted(100);
    expect(budget.canPurgePage()).toBe(false);
    expect(RETENTION_LIMITS.objects).toBe(2000);
  });

  it("allows at most `events` events a run", () => {
    const budget = new RunBudget();
    for (let i = 0; i < RETENTION_LIMITS.events; i++) {
      expect(budget.canStartEvent()).toBe(true);
      budget.eventStarted();
    }
    expect(budget.canStartEvent()).toBe(false);
  });

  it("the prune may spend what the purge left, never more than the limit", () => {
    const budget = new RunBudget();
    budget.spend(RETENTION_LIMITS.subrequests - 2);
    expect(budget.canSpend(2)).toBe(true);
    expect(budget.canSpend(3)).toBe(false);
  });
});
