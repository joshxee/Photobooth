import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminEvent, AdminEventList, ErrorBody } from "../../../shared/schemas";
import { createApp } from "../../app";
import { listAudit } from "../../db/audit";
import { insertDevice } from "../../db/devices";
import { getEvent, insertEvent } from "../../db/events";
import { insertPhotoIfUnderLimit, markVariantStored, publishPhotoIfComplete, rejectPhoto, setPhotoHidden } from "../../db/photos";
import { ADMIN_EMAIL, ADMIN_ORIGIN, adminHeaders, stubAccessCerts, userClaims } from "../../test/access";
import { deviceRow, eventRow, photoRow, resetDb } from "../../test/factories";

const ADMIN = "http://admin.localhost:8787";
const db = env.DB;
const DAY = 24 * 60 * 60 * 1000;

const CREATE = {
  name: "Smith wedding",
  venue: "The Boatshed",
  timezone: "Pacific/Auckland",
  startsAt: "2026-12-12T03:00:00.000Z",
  endsAt: "2026-12-12T11:00:00.000Z",
};

async function api(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const h = headers ?? (await adminHeaders());
  return exports.default.fetch(`${ADMIN}/api${path}`, {
    method,
    headers: h,
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
}

async function ok(res: Response, status = 200): Promise<AdminEvent> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${await res.text()}`);
  return AdminEvent.parse(await res.json());
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ErrorBody.parse(await res.json()).code).toBe(code);
}

async function create(overrides: Record<string, unknown> = {}): Promise<AdminEvent> {
  return ok(await api("POST", "/events", { ...CREATE, ...overrides }), 201);
}

const auditFor = (eventId: string) => listAudit(db, { eventId, limit: 100 });

beforeEach(async () => {
  await resetDb();
  stubAccessCerts();
});
afterEach(() => vi.restoreAllMocks());

describe("auth on the events API", () => {
  it("rejects a request with no Access token (401) and an unlisted email (403)", async () => {
    const base = { Origin: ADMIN_ORIGIN, "Content-Type": "application/json" };
    await expectError(await api("GET", "/events", undefined, base), 401, "unauthorized");
    await expectError(await api("POST", "/events", CREATE, base), 401, "unauthorized");
    await expectError(await api("GET", "/events", undefined, await adminHeaders(userClaims({ email: "x@example.com" }))), 403, "forbidden");
  });

  it("rejects a cross-origin POST with a valid token (403) and changes nothing", async () => {
    const headers = { ...(await adminHeaders()), Origin: "https://evil.example.com" };
    await expectError(await api("POST", "/events", CREATE, headers), 403, "forbidden");
    const formPost = { ...(await adminHeaders()), "Content-Type": "application/x-www-form-urlencoded" };
    await expectError(await api("POST", "/events", CREATE, formPost), 403, "forbidden");
    const { results } = await db.prepare("SELECT id FROM events").all();
    expect(results).toEqual([]);
  });

  it("protects every route, not only some", async () => {
    const e = await create();
    const noToken = { Origin: ADMIN_ORIGIN, "Content-Type": "application/json" };
    const routes: [string, string][] = [
      ["GET", "/events"],
      ["GET", `/events/${e.id}`],
      ["POST", "/events"],
      ["PATCH", `/events/${e.id}`],
      ...["open", "close", "publish", "suspend", "rotate-link", "delete", "restore"].map((a): [string, string] => ["POST", `/events/${e.id}/${a}`]),
    ];
    for (const [method, path] of routes) {
      const res = await api(method, path, method === "GET" ? undefined : {}, noToken);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("create, get and list", () => {
  it("creates a DRAFT, HIDDEN event with defaults, the gallery URL and uploadsUntil, and audits it", async () => {
    const e = await create();
    expect(e).toMatchObject({
      ...CREATE,
      uploadStatus: "DRAFT",
      galleryStatus: "HIDDEN",
      accessVersion: 1,
      photoLimit: 2000,
      uploadsUntil: new Date(Date.parse(CREATE.endsAt) + 90 * DAY).toISOString(),
      deletedAt: null,
      purgeAfter: null,
      counts: { pending: 0, ready: 0, rejected: 0, hidden: 0 },
    });
    const row = await getEvent(db, e.id);
    expect(e.galleryUrl).toBe(`http://photos.localhost:8787/e/${row!.public_id}#k=${row!.share_token}`);
    expect(e.publicId).toBe(row!.public_id);

    const audit = await auditFor(e.id);
    expect(audit).toEqual([
      expect.objectContaining({ actor: ADMIN_EMAIL, action: "event.create", event_id: e.id, detail: { name: CREATE.name } }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(row!.share_token);
  });

  it("takes venue and photoLimit when given", async () => {
    const e = await create({ venue: undefined, photoLimit: 50 });
    expect(e.venue).toBe("");
    expect(e.photoLimit).toBe(50);
  });

  it.each([
    ["an unknown field", { ...CREATE, uploadStatus: "OPEN" }],
    ["endsAt before startsAt", { ...CREATE, endsAt: "2026-12-12T02:00:00.000Z" }],
    ["a missing name", { ...CREATE, name: undefined }],
    ["a non-millisecond time", { ...CREATE, startsAt: "2026-12-12T03:00:00Z" }],
    ["an unknown time zone", { ...CREATE, timezone: "Mars/Olympus" }],
  ])("rejects %s with 400 and writes nothing", async (_name, body) => {
    await expectError(await api("POST", "/events", body), 400, "invalid_request");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>())?.n).toBe(0);
    expect(await listAudit(db, { limit: 10 })).toEqual([]);
  });

  it("rejects a body that is not JSON with 400", async () => {
    const res = await exports.default.fetch(`${ADMIN}/api/events`, { method: "POST", headers: await adminHeaders(), body: "{not json" });
    await expectError(res, 400, "invalid_request");
  });

  it("rejects an oversized body with 413", async () => {
    await expectError(await api("POST", "/events", { ...CREATE, venue: "x".repeat(70_000) }), 413, "too_large");
  });

  it("gets one event and 404s for unknown or malformed IDs", async () => {
    const e = await create();
    expect(await ok(await api("GET", `/events/${e.id}`))).toEqual(e);
    await expectError(await api("GET", "/events/01890000-0000-7000-8000-000000000000"), 404, "not_found");
    await expectError(await api("GET", "/events/not-an-id"), 404, "not_found");
    await expectError(await api("POST", "/events/not-an-id/open"), 404, "not_found");
  });

  it("lists every event (deleted included), newest start first, as AdminEventList", async () => {
    const early = await create({ name: "Early" });
    const late = await create({ name: "Late", startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-01-01T05:00:00.000Z" });
    await ok(await api("POST", `/events/${early.id}/delete`));
    const res = await api("GET", "/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const list = AdminEventList.parse(await res.json());
    expect(list.events.map((e) => e.name)).toEqual(["Late", "Early"]);
    expect(list.events[1]!.deletedAt).not.toBeNull();
    expect(list.events[0]!.id).toBe(late.id);
  });

  it("returns photo counts by state, scoped to each event", async () => {
    const mine = await create();
    const theirs = await create({ name: "Other" });
    const device = deviceRow();
    await insertDevice(db, device).run();
    const add = async (eventId: string, state: "PENDING" | "READY" | "REJECTED", hidden = false) => {
      const p = photoRow({ event_id: eventId, device_id: device.id });
      await insertPhotoIfUnderLimit(db, p);
      if (state === "READY") await db.batch([markVariantStored(db, p.id, "thumb"), markVariantStored(db, p.id, "hd"), publishPhotoIfComplete(db, p.id, new Date())]);
      if (state === "REJECTED") await rejectPhoto(db, p.id, "bad").run();
      if (hidden) await setPhotoHidden(db, eventId, p.id, true).run();
    };
    await add(mine.id, "READY");
    await add(mine.id, "READY", true);
    await add(mine.id, "PENDING");
    await add(mine.id, "REJECTED");
    await add(theirs.id, "READY");

    expect((await ok(await api("GET", `/events/${mine.id}`))).counts).toEqual({ pending: 1, ready: 2, rejected: 1, hidden: 1 });
    const list = AdminEventList.parse(await (await api("GET", "/events")).json());
    expect(list.events.find((e) => e.id === theirs.id)!.counts).toEqual({ pending: 0, ready: 1, rejected: 0, hidden: 0 });
  });
});

describe("update", () => {
  it("changes the given fields, bumps updatedAt and audits the field names", async () => {
    const e = await create();
    const updated = await ok(await api("PATCH", `/events/${e.id}`, { name: "Renamed", photoLimit: 10 }));
    expect(updated).toMatchObject({ name: "Renamed", photoLimit: 10, venue: CREATE.venue });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(e.updatedAt));
    const [latest] = await auditFor(e.id);
    expect(latest).toMatchObject({ action: "event.update", actor: ADMIN_EMAIL, detail: { fields: ["name", "photoLimit"] } });
  });

  it("recomputes uploadsUntil when endsAt changes", async () => {
    const e = await create();
    const endsAt = "2026-12-13T11:00:00.000Z";
    const updated = await ok(await api("PATCH", `/events/${e.id}`, { endsAt }));
    expect(updated.uploadsUntil).toBe(new Date(Date.parse(endsAt) + 90 * DAY).toISOString());
    expect((await getEvent(db, e.id))!.uploads_until).toBe(updated.uploadsUntil);
  });

  it("checks endsAt >= startsAt on the merged event (400, not a 500 from the DB check)", async () => {
    const e = await create();
    await expectError(await api("PATCH", `/events/${e.id}`, { endsAt: "2026-12-12T02:00:00.000Z" }), 400, "invalid_request");
    await expectError(await api("PATCH", `/events/${e.id}`, { startsAt: "2026-12-12T12:00:00.000Z" }), 400, "invalid_request");
    expect((await getEvent(db, e.id))!.ends_at).toBe(CREATE.endsAt);
    expect((await auditFor(e.id)).map((a) => a.action)).toEqual(["event.create"]);
  });

  it("rejects an empty body, a status field and unknown fields", async () => {
    const e = await create();
    await expectError(await api("PATCH", `/events/${e.id}`, {}), 400, "invalid_request");
    await expectError(await api("PATCH", `/events/${e.id}`, { uploadStatus: "OPEN" }), 400, "invalid_request");
    await expectError(await api("PATCH", `/events/${e.id}`, { shareToken: "x" }), 400, "invalid_request");
  });

  it("404s for an unknown event and 409s for a deleted one", async () => {
    await expectError(await api("PATCH", "/events/01890000-0000-7000-8000-000000000000", { name: "x" }), 404, "not_found");
    const e = await create();
    await ok(await api("POST", `/events/${e.id}/delete`));
    await expectError(await api("PATCH", `/events/${e.id}`, { name: "x" }), 409, "conflict");
  });

  it("returns 409 and writes no audit row when another admin changed the event in between", async () => {
    const e = await create();
    // A D1 binding that lets "another admin" write between this request's read and its batch.
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await env.DB.prepare("UPDATE events SET name = 'Theirs', updated_at = ? WHERE id = ?")
              .bind(new Date(Date.now() + 60_000).toISOString(), e.id)
              .run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const req = new Request(`${ADMIN}/api/events/${e.id}`, { method: "PATCH", headers: await adminHeaders(), body: JSON.stringify({ name: "Mine" }) });
    const res = await createApp().fetch(req, { ...env, DB: racing }, createExecutionContext());
    await expectError(res, 409, "conflict");
    expect((await getEvent(db, e.id))!.name).toBe("Theirs");
    expect((await auditFor(e.id)).map((a) => a.action)).toEqual(["event.create"]);
  });
});

describe("lifecycle actions", () => {
  it("runs the whole lifecycle and audits every step with the actor", async () => {
    const e = await create();
    expect((await ok(await api("POST", `/events/${e.id}/open`))).uploadStatus).toBe("OPEN");
    expect((await ok(await api("POST", `/events/${e.id}/publish`))).galleryStatus).toBe("LIVE");
    expect((await ok(await api("POST", `/events/${e.id}/suspend`))).galleryStatus).toBe("SUSPENDED");
    expect((await ok(await api("POST", `/events/${e.id}/publish`))).galleryStatus).toBe("LIVE");
    expect((await ok(await api("POST", `/events/${e.id}/close`))).uploadStatus).toBe("CLOSED");
    expect((await ok(await api("POST", `/events/${e.id}/open`))).uploadStatus).toBe("OPEN");
    const audit = await auditFor(e.id);
    expect(audit.map((a) => a.action).reverse()).toEqual([
      "event.create",
      "event.open",
      "event.publish",
      "event.suspend",
      "event.publish",
      "event.close",
      "event.open",
    ]);
    expect(audit.every((a) => a.actor === ADMIN_EMAIL && a.event_id === e.id)).toBe(true);
  });

  it.each([
    ["close", "a DRAFT event"],
    ["suspend", "a HIDDEN gallery"],
    ["restore", "an event that isn't deleted"],
  ])("refuses %s on %s with 409 and no audit row", async (action) => {
    const e = await create();
    await expectError(await api("POST", `/events/${e.id}/${action}`), 409, "conflict");
    expect((await auditFor(e.id)).map((a) => a.action)).toEqual(["event.create"]);
  });

  it("refuses to open twice or publish twice", async () => {
    const e = await create();
    await ok(await api("POST", `/events/${e.id}/open`));
    await expectError(await api("POST", `/events/${e.id}/open`), 409, "conflict");
    await ok(await api("POST", `/events/${e.id}/publish`));
    await expectError(await api("POST", `/events/${e.id}/publish`), 409, "conflict");
  });

  it("refuses to open once the upload window has passed, but still publishes (D15)", async () => {
    const e = await create({ startsAt: "2020-01-01T00:00:00.000Z", endsAt: "2020-01-01T05:00:00.000Z" });
    await expectError(await api("POST", `/events/${e.id}/open`), 409, "conflict");
    expect((await ok(await api("POST", `/events/${e.id}/publish`))).galleryStatus).toBe("LIVE");
  });

  it("404s for an unknown event or action", async () => {
    await expectError(await api("POST", "/events/01890000-0000-7000-8000-000000000000/open"), 404, "not_found");
    const e = await create();
    await expectError(await api("POST", `/events/${e.id}/explode`), 404, "not_found");
    await expectError(await api("GET", `/events/${e.id}/open`), 404, "not_found");
  });
});

describe("rotate-link", () => {
  it("issues a new token, bumps accessVersion, and audits the version but never the token", async () => {
    const e = await create();
    const before = (await getEvent(db, e.id))!;
    const rotated = await ok(await api("POST", `/events/${e.id}/rotate-link`));
    const after = (await getEvent(db, e.id))!;
    expect(after.share_token).not.toBe(before.share_token);
    expect(rotated.accessVersion).toBe(2);
    expect(rotated.galleryUrl).toBe(`http://photos.localhost:8787/e/${before.public_id}#k=${after.share_token}`);
    expect(rotated.galleryUrl).not.toContain(before.share_token);

    const [latest] = await auditFor(e.id);
    expect(latest).toMatchObject({ action: "event.rotate_link", detail: { accessVersion: 2 } });
    const allAudit = JSON.stringify(await auditFor(e.id));
    expect(allAudit).not.toContain(before.share_token);
    expect(allAudit).not.toContain(after.share_token);

    expect((await ok(await api("POST", `/events/${e.id}/rotate-link`))).accessVersion).toBe(3);
  });
});

describe("delete and restore", () => {
  it("soft-deletes with a 7-day undo; only restore is allowed meanwhile", async () => {
    const e = await create();
    await ok(await api("POST", `/events/${e.id}/publish`));
    const deleted = await ok(await api("POST", `/events/${e.id}/delete`));
    expect(deleted.deletedAt).not.toBeNull();
    expect(Date.parse(deleted.purgeAfter!) - Date.parse(deleted.deletedAt!)).toBe(7 * DAY);
    for (const action of ["open", "publish", "suspend", "rotate-link", "delete"]) {
      await expectError(await api("POST", `/events/${e.id}/${action}`), 409, "conflict");
    }
    const restored = await ok(await api("POST", `/events/${e.id}/restore`));
    expect(restored).toMatchObject({ deletedAt: null, purgeAfter: null, galleryStatus: "LIVE" });
    expect((await auditFor(e.id)).map((a) => a.action).slice(0, 2)).toEqual(["event.restore", "event.delete"]);
  });

  it("refuses to restore once purge_after has passed", async () => {
    const row = eventRow({ deleted_at: "2026-01-01T00:00:00.000Z", purge_after: "2026-01-08T00:00:00.000Z" });
    await insertEvent(db, row).run();
    await expectError(await api("POST", `/events/${row.id}/restore`), 409, "conflict");
  });
});
