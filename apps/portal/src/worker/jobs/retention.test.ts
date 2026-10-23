import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminEvent } from "../../shared/schemas";
import { listAudit } from "../db/audit";
import { getEvent } from "../db/events";
import { newId } from "../domain/ids";
import { eventPrefix, variantKey } from "../domain/media";
import { RETENTION_LIMITS } from "../domain/retention";
import worker from "../index";
import { adminHeaders, stubAccessCerts } from "../test/access";
import { eventRow, resetDb } from "../test/factories";
import { insertPhoto, liveEvent } from "../test/guest";
import { runRetention } from "./retention";

const NOW = new Date("2026-11-20T14:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(async () => {
  await resetDb();
  await clearBucket();
  stubAccessCerts();
});
afterEach(() => vi.restoreAllMocks());

async function clearBucket(): Promise<void> {
  for (;;) {
    const page = await env.MEDIA.list({ limit: 1000 });
    if (page.objects.length === 0) return;
    await env.MEDIA.delete(page.objects.map((o) => o.key));
  }
}

async function keysOf(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** An event deleted so that its undo ends at `purgeAfter` (default: it has just run out at NOW). */
async function deletedEvent(purgeAfter = NOW.toISOString(), overrides: Partial<Parameters<typeof eventRow>[0]> = {}) {
  return liveEvent({ deleted_at: iso(Date.parse(purgeAfter) - 7 * DAY), purge_after: purgeAfter, ...overrides });
}

/** `count` stand-in objects under the event's prefix (no rows): variants of photos that never became READY, late writes. */
async function putObjects(eventId: string, count: number): Promise<void> {
  const keys = Array.from({ length: count }, (_, i) => variantKey(eventId, `stray-${i}`, i % 2 ? "hd" : "thumb"));
  for (let i = 0; i < keys.length; i += 100) {
    await Promise.all(keys.slice(i, i + 100).map((k) => env.MEDIA.put(k, "x")));
  }
}

async function auditRows(action?: string) {
  const rows = await listAudit(env.DB, { limit: 1000 });
  return action ? rows.filter((r) => r.action === action) : rows;
}

async function count(table: "events" | "photos" | "audit"): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

/**
 * The job's bindings with every D1 and R2 call counted: what Workers Free bills as subrequests,
 * and the key counts of R2 batch deletes. `calls` includes the failures the test injects.
 */
function counted() {
  const stats = { calls: 0, listCalls: 0, deleteSizes: [] as number[] };
  const targets = new WeakMap<object, D1PreparedStatement>();
  const wrapStatement = (s: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(s, {
      get(t, p) {
        if (p === "bind") return (...a: unknown[]) => wrapStatement(t.bind(...a));
        if (p === "run" || p === "all" || p === "first" || p === "raw") {
          return (...a: unknown[]) => {
            stats.calls++;
            return (t as never as Record<string, (...x: unknown[]) => unknown>)[p as string]!(...a);
          };
        }
        return Reflect.get(t, p) as unknown;
      },
    });
    targets.set(proxy, s);
    return proxy;
  };
  const DB = {
    prepare: (sql: string) => wrapStatement(env.DB.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => {
      stats.calls++;
      return env.DB.batch(statements.map((s) => targets.get(s) ?? s));
    },
  } as unknown as D1Database;
  const MEDIA = {
    list: (options?: R2ListOptions) => {
      stats.calls++;
      stats.listCalls++;
      return env.MEDIA.list(options);
    },
    delete: (keys: string | string[]) => {
      stats.calls++;
      stats.deleteSizes.push(Array.isArray(keys) ? keys.length : 1);
      return env.MEDIA.delete(keys);
    },
  } as unknown as R2Bucket;
  return { bindings: { DB, MEDIA }, stats };
}

describe("purging deleted events", () => {
  it("purges an event at exactly purge_after: its objects, rows and photos go, one audit row stays", async () => {
    const event = await deletedEvent(NOW.toISOString(), { name: "Hana & Tom" });
    const ready = await insertPhoto(event);
    const pending = await insertPhoto(event, { state: "PENDING" });
    const rejected = await insertPhoto(event, { state: "REJECTED" });
    const result = await runRetention(env, NOW);

    expect(result).toMatchObject({ purgedEvents: 1, deletedObjects: 6, pendingEvents: 0, failures: 0 });
    expect(await keysOf("events/")).toEqual([]);
    expect(await getEvent(env.DB, event.id)).toBeNull();
    expect(await count("photos")).toBe(0);
    const rows = await auditRows("event.purge");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "system",
      action: "event.purge",
      event_id: event.id,
      target_id: event.id,
      at: NOW.toISOString(),
      detail: { name: "Hana & Tom", photos: 3 },
    });
    expect([ready.id, pending.id, rejected.id]).toHaveLength(3);
  });

  it("does not purge one millisecond before purge_after, nor a deleted event still inside its undo", async () => {
    const early = await deletedEvent(iso(NOW.getTime() + 1));
    const inside = await deletedEvent(iso(NOW.getTime() + 6 * DAY));
    await insertPhoto(early);
    await insertPhoto(inside);
    const result = await runRetention(env, NOW);
    expect(result).toMatchObject({ purgedEvents: 0, deletedObjects: 0 });
    expect(await keysOf("events/")).toHaveLength(4);
    expect(await getEvent(env.DB, early.id)).not.toBeNull();
    expect(await getEvent(env.DB, inside.id)).not.toBeNull();
    expect(await count("photos")).toBe(2);
    expect(await auditRows("event.purge")).toEqual([]);
  });

  it("never purges an event that is not deleted, however old: past uploads_until its photos stay (D15)", async () => {
    const old = await liveEvent({
      starts_at: "2026-01-10T05:00:00.000Z",
      ends_at: "2026-01-10T11:00:00.000Z",
      uploads_until: "2026-04-10T11:00:00.000Z",
      upload_status: "CLOSED",
    });
    await insertPhoto(old);
    const result = await runRetention(env, NOW);
    expect(result).toMatchObject({ purgedEvents: 0, deletedObjects: 0, failures: 0 });
    expect(await keysOf("events/")).toHaveLength(2);
    expect(await getEvent(env.DB, old.id)).not.toBeNull();
    expect(await count("photos")).toBe(1);
  });

  it("does not purge an event restored before its purge date", async () => {
    // Deleted an hour ago on the real clock, so the admin API still allows the restore.
    const event = await deletedEvent(iso(Date.now() + 6 * DAY));
    await insertPhoto(event);
    const res = await exports.default.fetch(`http://admin.localhost:8787/api/events/${event.id}/restore`, {
      method: "POST",
      headers: await adminHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(AdminEvent.parse(await res.json())).toMatchObject({ deletedAt: null, purgeAfter: null });

    // A run long after the old purge date: the event is no longer deleted, so it is not due.
    expect(await runRetention(env, new Date(Date.now() + 30 * DAY))).toMatchObject({ purgedEvents: 0, deletedObjects: 0 });
    expect(await keysOf("events/")).toHaveLength(2);
    expect(await count("photos")).toBe(1);
  });

  it("the undo is over once the purge date has passed: restore is 409 until the job runs, then 404", async () => {
    const event = await deletedEvent(iso(Date.now() - 60_000));
    const restore = async () =>
      exports.default.fetch(`http://admin.localhost:8787/api/events/${event.id}/restore`, { method: "POST", headers: await adminHeaders(), body: "{}" });
    expect((await restore()).status).toBe(409);
    await runRetention(env, new Date());
    expect(await getEvent(env.DB, event.id)).toBeNull();
    expect((await restore()).status).toBe(404);
  });

  it("deletes the whole prefix: variants of photos that never became READY and late writes after the deletion", async () => {
    const event = await deletedEvent();
    await insertPhoto(event, { state: "PENDING" });
    await insertPhoto(event, { state: "REJECTED" });
    // A late variant write after the deletion, and one for a photo with no row at all.
    await env.MEDIA.put(variantKey(event.id, "late-photo", "hd"), "late");
    await env.MEDIA.put(`${eventPrefix(event.id)}anything/else.bin`, "odd");
    const result = await runRetention(env, NOW);
    expect(result.deletedObjects).toBe(6);
    expect(await keysOf(eventPrefix(event.id))).toEqual([]);
  });

  it("touches nothing outside the event's prefix: another event, and a lookalike prefix", async () => {
    const event = await deletedEvent();
    const other = await liveEvent();
    await insertPhoto(event);
    await insertPhoto(other);
    const lookalike = `events/${event.id}0/photo/hd.jpg`;
    const sibling = `events/${event.id.slice(0, -1)}/photo/hd.jpg`;
    await env.MEDIA.put(lookalike, "x");
    await env.MEDIA.put(sibling, "x");
    await runRetention(env, NOW);
    expect(await keysOf("events/")).toEqual([...(await keysOf(eventPrefix(other.id))), lookalike, sibling].sort());
    expect(await getEvent(env.DB, other.id)).not.toBeNull();
    expect(await count("photos")).toBe(1);
  });

  it("purges several due events oldest first, in one run, and leaves other events' audit rows", async () => {
    const newer = await deletedEvent(iso(NOW.getTime() - DAY));
    const older = await deletedEvent(iso(NOW.getTime() - 3 * DAY));
    await insertPhoto(newer);
    await insertPhoto(older);
    const result = await runRetention(env, NOW);
    expect(result.purgedEvents).toBe(2);
    const purges = (await auditRows("event.purge")).map((r) => r.event_id).sort();
    expect(purges).toEqual([newer.id, older.id].sort());
  });
});

describe("purging more than one page", { timeout: 60_000 }, () => {
  it("resumes over runs: 2,500 objects take two runs, the event stays deleted until the prefix is empty", async () => {
    const event = await deletedEvent();
    await putObjects(event.id, 2500);

    const first = counted();
    const run1 = await runRetention(first.bindings, NOW);
    expect(run1).toMatchObject({ purgedEvents: 0, pendingEvents: 1, deletedObjects: 2000, failures: 0 });
    expect(await keysOf(eventPrefix(event.id))).toHaveLength(500);
    expect(await getEvent(env.DB, event.id)).toMatchObject({ deleted_at: expect.any(String) });
    expect(await auditRows("event.purge")).toEqual([]);
    expect(first.stats.deleteSizes).toEqual([1000, 1000]);

    const second = counted();
    const run2 = await runRetention(second.bindings, new Date(NOW.getTime() + DAY));
    expect(run2).toMatchObject({ purgedEvents: 1, pendingEvents: 0, deletedObjects: 500, failures: 0 });
    expect(await keysOf("events/")).toEqual([]);
    expect(await getEvent(env.DB, event.id)).toBeNull();
    expect(await auditRows("event.purge")).toHaveLength(1);
    expect(second.stats.deleteSizes).toEqual([500]);

    const third = await runRetention(env, new Date(NOW.getTime() + 2 * DAY));
    expect(third).toMatchObject({ purgedEvents: 0, pendingEvents: 0, deletedObjects: 0 });
  });

  it("exactly one full page finishes in one run", async () => {
    const event = await deletedEvent();
    await putObjects(event.id, 1000);
    const run = await runRetention(env, NOW);
    expect(run).toMatchObject({ purgedEvents: 1, deletedObjects: 1000, pendingEvents: 0 });
    expect(await getEvent(env.DB, event.id)).toBeNull();
  });

  it("a run that hits its page budget leaves the next event for tomorrow, and the audit prune still runs", async () => {
    const big = await deletedEvent(iso(NOW.getTime() - 2 * DAY));
    const small = await deletedEvent(iso(NOW.getTime() - DAY));
    await putObjects(big.id, 2100);
    await putObjects(small.id, 3);
    await insertOldAudit(5);
    const run = await runRetention(env, NOW);
    expect(run).toMatchObject({ purgedEvents: 0, pendingEvents: 2, deletedObjects: 2000, prunedAudit: 5 });
    expect(await keysOf(eventPrefix(small.id))).toHaveLength(3);
    const next = await runRetention(env, new Date(NOW.getTime() + DAY));
    expect(next).toMatchObject({ purgedEvents: 2, pendingEvents: 0, deletedObjects: 103 });
    expect(await count("events")).toBe(0);
  });
});

describe("the work budget", () => {
  it("stays within the subrequest limit even with a long backlog, and the backlog drains over runs", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const e = await deletedEvent(iso(NOW.getTime() - (60 - i) * 60_000));
      await putObjects(e.id, 2);
      ids.push(e.id);
    }
    let day = 0;
    let remaining = 30;
    while (remaining > 0) {
      const { bindings, stats } = counted();
      const run = await runRetention(bindings, new Date(NOW.getTime() + day++ * DAY));
      expect(stats.calls).toBeLessThanOrEqual(RETENTION_LIMITS.subrequests);
      expect(run.subrequests).toBe(stats.calls);
      expect(run.purgedEvents).toBeGreaterThan(0);
      expect(run.purgedEvents).toBeLessThanOrEqual(RETENTION_LIMITS.events);
      remaining -= run.purgedEvents;
      expect(day).toBeLessThan(10);
    }
    expect(await count("events")).toBe(0);
    expect(await keysOf("events/")).toEqual([]);
    expect(await auditRows("event.purge")).toHaveLength(30);
  });

  it("counts every D1 and R2 call it makes", async () => {
    const event = await deletedEvent();
    await putObjects(event.id, 5);
    const { bindings, stats } = counted();
    const run = await runRetention(bindings, NOW);
    // list due events, list objects, delete them, one batch for the audit row and the event, prune.
    expect(stats.calls).toBe(5);
    expect(run.subrequests).toBe(5);
  });

  it("with nothing to do it is two calls: the due-events query and the prune", async () => {
    const { bindings, stats } = counted();
    expect(await runRetention(bindings, NOW)).toMatchObject({ purgedEvents: 0, prunedAudit: 0, subrequests: 2 });
    expect(stats.calls).toBe(2);
  });
});

async function insertOldAudit(rows: number, ageMs = 100 * DAY, action = "event.open"): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const base = NOW.getTime() - ageMs;
  for (let i = 0; i < rows; i++) {
    stmts.push(
      env.DB.prepare("INSERT INTO audit (id, at, actor, action, event_id, target_id, detail) VALUES (?, ?, 'a@example.com', ?, NULL, NULL, NULL)").bind(
        newId(new Date(base + i)),
        iso(base + i),
        action,
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

describe("pruning the audit log", () => {
  it("deletes rows older than 90 days and keeps the cutoff row and newer ones", async () => {
    const cutoff = NOW.getTime() - 90 * DAY;
    const row = (id: string, at: number) =>
      env.DB.prepare("INSERT INTO audit (id, at, actor, action) VALUES (?, ?, 'a@example.com', 'event.open')").bind(id, iso(at));
    await env.DB.batch([row("old", cutoff - 1), row("exact", cutoff), row("new", cutoff + 1), row("fresh", NOW.getTime())]);
    const run = await runRetention(env, NOW);
    expect(run.prunedAudit).toBe(1);
    const left = (await auditRows()).map((r) => r.id).filter((id) => ["old", "exact", "new", "fresh"].includes(id));
    expect(left.sort()).toEqual(["exact", "fresh", "new"]);
  });

  it("writes an audit row of its own saying how many it removed", async () => {
    await insertOldAudit(7);
    await runRetention(env, NOW);
    const rows = await auditRows("audit.prune");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "system", event_id: null, at: NOW.toISOString(), detail: { rows: 7, olderThan: "2026-08-22T14:00:00.000Z" } });
    // Nothing to prune, nothing written.
    await runRetention(env, new Date(NOW.getTime() + 1000));
    expect(await auditRows("audit.prune")).toHaveLength(1);
  });

  it("prunes in batches of 500 and at most 1,500 rows a run; the rest goes the next day", async () => {
    await insertOldAudit(1700);
    const first = counted();
    const run1 = await runRetention(first.bindings, NOW);
    expect(run1.prunedAudit).toBe(1500);
    expect(await count("audit")).toBe(200 + 1);
    const run2 = await runRetention(env, new Date(NOW.getTime() + DAY));
    expect(run2.prunedAudit).toBe(200);
    // Only the two prune records remain.
    expect((await auditRows()).map((r) => r.action).sort()).toEqual(["audit.prune", "audit.prune"]);
  });

  it("keeps a purge's own audit row for 90 days", async () => {
    const event = await deletedEvent();
    await runRetention(env, NOW);
    await runRetention(env, new Date(NOW.getTime() + 89 * DAY));
    expect(await auditRows("event.purge")).toHaveLength(1);
    await runRetention(env, new Date(NOW.getTime() + 91 * DAY));
    expect(await auditRows("event.purge")).toEqual([]);
    expect(event.id).toBeTruthy();
  });
});

describe("idempotence and failure", () => {
  it("a second run changes nothing: no new audit rows, nothing deleted", async () => {
    const event = await deletedEvent();
    await insertPhoto(event);
    await insertOldAudit(3);
    const first = await runRetention(env, NOW);
    expect(first).toMatchObject({ purgedEvents: 1, prunedAudit: 3 });
    const before = await auditRows();
    const second = await runRetention(env, NOW);
    expect(second).toMatchObject({ purgedEvents: 0, deletedObjects: 0, prunedAudit: 0, pendingEvents: 0, failures: 0 });
    expect(await auditRows()).toEqual(before);
  });

  it("an R2 failure on one event is logged and counted, other events and the prune still run, and the failed event resumes", async () => {
    const bad = await deletedEvent(iso(NOW.getTime() - 2 * DAY));
    const good = await deletedEvent(iso(NOW.getTime() - DAY));
    await putObjects(bad.id, 3);
    await putObjects(good.id, 3);
    await insertOldAudit(2);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bindings } = counted();
    const realDelete = bindings.MEDIA.delete.bind(bindings.MEDIA);
    let first = true;
    bindings.MEDIA.delete = (async (keys: string | string[]) => {
      if (first) {
        first = false;
        throw new Error("R2 is having a day");
      }
      return realDelete(keys);
    }) as R2Bucket["delete"];

    const run = await runRetention(bindings, NOW);
    expect(run).toMatchObject({ purgedEvents: 1, failures: 1, pendingEvents: 1, prunedAudit: 2 });
    expect(await getEvent(env.DB, good.id)).toBeNull();
    expect(await getEvent(env.DB, bad.id)).not.toBeNull();
    expect(await keysOf(eventPrefix(bad.id))).toHaveLength(3);
    const lines = error.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({ level: "error", outcome: "retention_event_failed", eventId: bad.id, errorName: "Error" })]);
    expect(JSON.stringify(lines)).not.toContain("having a day");

    const retry = await runRetention(env, new Date(NOW.getTime() + DAY));
    expect(retry).toMatchObject({ purgedEvents: 1, failures: 0 });
    expect(await getEvent(env.DB, bad.id)).toBeNull();
  });

  it("an event restored while the job ran is kept: the final write is guarded, no audit row is written", async () => {
    const event = await deletedEvent();
    await insertPhoto(event);
    // Restore lands between the job's read and its final write.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bindings } = counted();
    const realDelete = bindings.MEDIA.delete.bind(bindings.MEDIA);
    bindings.MEDIA.delete = (async (keys: string | string[]) => {
      await env.DB.prepare("UPDATE events SET deleted_at = NULL, purge_after = NULL WHERE id = ?").bind(event.id).run();
      return realDelete(keys);
    }) as R2Bucket["delete"];
    const run = await runRetention(bindings, NOW);
    expect(run).toMatchObject({ purgedEvents: 0, pendingEvents: 0, failures: 0 });
    expect(warn.mock.calls.map((a) => JSON.parse(String(a[0])))).toEqual([expect.objectContaining({ outcome: "retention_event_restored", eventId: event.id })]);
    expect(await getEvent(env.DB, event.id)).not.toBeNull();
    expect(await count("photos")).toBe(1);
    expect(await auditRows("event.purge")).toEqual([]);
  });
});

describe("logging", () => {
  it("logs one summary line with counts only, in the DESIGN §15 shape", async () => {
    const event = await deletedEvent(NOW.toISOString(), { name: "SECRET-NAME", share_token: "SECRET-TOKEN" });
    await insertPhoto(event);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runRetention(env, NOW);
    const lines = log.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    const summary = lines.find((l) => l.outcome === "retention_run");
    expect(summary).toMatchObject({
      level: "info",
      outcome: "retention_run",
      purgedEvents: 1,
      pendingEvents: 0,
      deletedObjects: 2,
      prunedAudit: 0,
      failures: 0,
    });
    expect(typeof summary?.subrequests).toBe("number");
    expect(typeof summary?.durationMs).toBe("number");
    expect(summary).toHaveProperty("version");
    const everything = JSON.stringify(lines);
    for (const secret of ["SECRET-NAME", "SECRET-TOKEN", event.share_token, event.public_id]) expect(everything).not.toContain(secret);
  });

  it("logs each purged event by ID", async () => {
    const event = await deletedEvent();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runRetention(env, NOW);
    const lines = log.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ outcome: "retention_event_purged", eventId: event.id }));
  });
});

describe("the scheduled handler", () => {
  it("runs the job at the trigger's time with the Worker's bindings", async () => {
    const event = await deletedEvent();
    await insertPhoto(event);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled({ cron: "0 14 * * *", scheduledTime: NOW.getTime(), noRetry() {} }, env);
    expect(await getEvent(env.DB, event.id)).toBeNull();
    expect(await keysOf("events/")).toEqual([]);
  });

  it("fails the invocation when an event failed, so it shows as an error in Observability", async () => {
    const event = await deletedEvent();
    await putObjects(event.id, 2);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { DB: env.DB, MEDIA: { list: () => Promise.reject(new Error("boom")), delete: env.MEDIA.delete.bind(env.MEDIA) } } as unknown as Env;
    await expect(worker.scheduled({ cron: "0 14 * * *", scheduledTime: NOW.getTime(), noRetry() {} }, broken)).rejects.toThrow(
      "1 event(s) failed",
    );
    expect(await getEvent(env.DB, event.id)).not.toBeNull();
  });
});
