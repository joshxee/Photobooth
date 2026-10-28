import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS, AuditList, ErrorBody } from "../../../shared/schemas";
import { type AuditEntry, insertAudit, listAudit } from "../../db/audit";
import { runRetention } from "../../jobs/retention";
import { newId } from "../../domain/ids";
import { ADMIN_EMAIL, adminHeaders, stubAccessCerts } from "../../test/access";
import { resetDb } from "../../test/factories";
import { insertPhoto, liveEvent } from "../../test/guest";
import { emptyBucket } from "../../test/upload";

const ADMIN = "http://admin.localhost:8787";
const GALLERY = "http://photos.localhost:8787";
const db = env.DB;

async function api(method: string, path: string, body?: unknown) {
  return exports.default.fetch(`${ADMIN}/api${path}`, {
    method,
    headers: await adminHeaders(),
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
}

async function ok(res: Response): Promise<unknown> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function list(query = ""): Promise<AuditList> {
  return AuditList.parse(await ok(await api("GET", `/audit${query}`)));
}

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return { id: newId(), at: "2026-10-22T09:00:00.000Z", actor: "a@example.com", action: "event.create", event_id: null, target_id: null, detail: null, ...over };
}

beforeEach(async () => {
  await resetDb();
  await emptyBucket();
  stubAccessCerts();
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/audit", () => {
  it("lists newest first in the contract's shape", async () => {
    const eventId = newId();
    const first = entry({ at: "2026-10-22T09:00:00.000Z", event_id: eventId, target_id: eventId, detail: { name: "x" } });
    const second = entry({ at: "2026-10-22T09:05:00.000Z", action: "device.create", target_id: "d-1" });
    await db.batch([insertAudit(db, first), insertAudit(db, second)]);
    const page = await list();
    expect(page).toEqual({
      entries: [
        { id: second.id, at: second.at, actor: "a@example.com", action: "device.create", eventId: null, targetId: "d-1", detail: null },
        { id: first.id, at: first.at, actor: "a@example.com", action: "event.create", eventId: eventId, targetId: eventId, detail: { name: "x" } },
      ],
      nextCursor: null,
    });
  });

  it("filters by event and by action, and by both", async () => {
    const a = newId();
    const b = newId();
    await db.batch([
      insertAudit(db, entry({ at: "2026-10-22T09:01:00.000Z", event_id: a, action: "event.create" })),
      insertAudit(db, entry({ at: "2026-10-22T09:02:00.000Z", event_id: a, action: "photo.hide" })),
      insertAudit(db, entry({ at: "2026-10-22T09:03:00.000Z", event_id: b, action: "photo.hide" })),
      insertAudit(db, entry({ at: "2026-10-22T09:04:00.000Z", event_id: null, action: "device.create" })),
    ]);
    const shape = async (query: string) => (await list(query)).entries.map((e) => `${e.eventId === a ? "a" : e.eventId === b ? "b" : "-"}:${e.action}`);
    expect(await shape(`?event=${a}`)).toEqual(["a:photo.hide", "a:event.create"]);
    expect(await shape("?action=photo.hide")).toEqual(["b:photo.hide", "a:photo.hide"]);
    expect(await shape(`?event=${a}&action=photo.hide`)).toEqual(["a:photo.hide"]);
    expect(await shape("?action=device.create")).toEqual(["-:device.create"]);
    expect(await shape(`?event=${newId()}`)).toEqual([]);
  });

  it("pages by (time, id) with no duplicates or gaps, even for entries in the same millisecond", async () => {
    const rows: AuditEntry[] = [];
    for (let i = 0; i < 7; i++) rows.push(entry({ at: `2026-10-22T09:00:0${Math.floor(i / 2)}.000Z` }));
    await db.batch(rows.map((r) => insertAudit(db, r)));
    const expected = (await listAudit(db, { limit: 100 })).map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: AuditList = await list(`?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(7);
  });

  it("pages within a filter", async () => {
    const e = newId();
    for (let i = 0; i < 5; i++) await db.batch([insertAudit(db, entry({ at: `2026-10-22T09:00:0${i}.000Z`, event_id: e, action: "photo.hide" })), insertAudit(db, entry({ at: `2026-10-22T09:00:0${i}.500Z`, action: "device.create" }))]);
    const first = await list(`?event=${e}&limit=2`);
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(`?event=${e}&limit=2&cursor=${first.nextCursor}`);
    const third = await list(`?event=${e}&limit=2&cursor=${second.nextCursor}`);
    expect([...first.entries, ...second.entries, ...third.entries].map((x) => x.action)).toEqual(Array(5).fill("photo.hide"));
    expect(third.nextCursor).toBeNull();
  });

  it("rejects an unknown action, a malformed event or cursor, a bad limit and unknown parameters (400)", async () => {
    for (const query of ["?action=nope", "?event=1", "?cursor=!!", "?cursor=YQ", "?limit=0", "?limit=101", "?x=1"]) {
      const res = await api("GET", `/audit${query}`);
      expect(res.status, query).toBe(400);
      expect(ErrorBody.parse(await res.json()).code).toBe("invalid_request");
    }
  });

  it("is no-store and carries no secrets from the events it describes", async () => {
    const event = await liveEvent();
    await ok(await api("POST", `/events/${event.id}/rotate-link`));
    const res = await api("GET", "/audit");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(event.share_token);
  });
});

describe("every mutation is audited", () => {
  it("each action through the API leaves one row for the acting admin; with the device and the job, the list shows every action there is", async () => {
    // Events (session 04)
    const created = (await ok(await api("POST", "/events", { name: "Audit gala", timezone: "Pacific/Auckland", startsAt: "2026-10-22T05:00:00.000Z", endsAt: "2026-10-22T11:00:00.000Z" }))) as { id: string };
    await ok(await api("PATCH", `/events/${created.id}`, { venue: "Hall" }));
    for (const action of ["open", "publish", "suspend", "publish", "rotate-link", "close", "delete", "restore"]) await ok(await api("POST", `/events/${created.id}/${action}`));
    // Devices (session 05); the enrolment is the device's own row.
    const device = (await ok(await api("POST", "/devices", { name: "Booth A" }))) as { deviceId: string };
    const reissued = (await ok(await api("POST", `/devices/${device.deviceId}/code`))) as { code: string };
    const enrol = await exports.default.fetch(`${GALLERY}/v1/device/enrol`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.99.0.1" },
      body: JSON.stringify({ code: reissued.code, name: "Booth A", appVersion: "0.4.0" }),
    });
    expect(enrol.status).toBe(201);
    await ok(await api("POST", `/devices/${device.deviceId}/revoke`));
    // Photos (session 15)
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    await ok(await api("POST", `/photos/${photo.id}/hide`));
    await ok(await api("POST", `/photos/${photo.id}/unhide`));
    await ok(await api("DELETE", `/photos/${photo.id}`));
    // The retention job (session 16): a purge, and a prune of a row older than 90 days.
    const old = await liveEvent({ deleted_at: "2026-01-01T00:00:00.000Z", purge_after: "2026-01-08T00:00:00.000Z" });
    await insertPhoto(old);
    await db.batch([insertAudit(db, entry({ at: "2026-01-01T00:00:00.000Z" }))]);
    await runRetention(env, new Date("2026-10-23T00:00:00.000Z"));

    const entries = (await list("?limit=100")).entries;
    const byAdmin = entries.filter((e) => e.actor === ADMIN_EMAIL).map((e) => e.action);
    expect(byAdmin.sort()).toEqual(
      [
        "event.create", "event.update", "event.open", "event.publish", "event.suspend", "event.publish", "event.rotate_link", "event.close", "event.delete", "event.restore",
        "device.create", "device.code", "device.revoke",
        "photo.hide", "photo.unhide", "photo.delete",
      ].sort(),
    );
    expect(entries.filter((e) => e.actor === `device:${device.deviceId}`).map((e) => e.action)).toEqual(["device.enrol"]);
    expect(entries.filter((e) => e.actor === "system").map((e) => e.action).sort()).toEqual(["audit.prune", "event.purge"]);
    // Nothing is written that the filter and the labels don't know, and nothing they know goes unwritten.
    expect([...new Set(entries.map((e) => e.action))].sort()).toEqual([...AUDIT_ACTIONS].sort());
  });
});
