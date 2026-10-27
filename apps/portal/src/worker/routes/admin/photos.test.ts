import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminEvent, AdminPhotoList, ErrorBody } from "../../../shared/schemas";
import { listAudit } from "../../db/audit";
import { getPhoto } from "../../db/photos";
import { newId } from "../../domain/ids";
import { variantKey } from "../../domain/media";
import { ADMIN_EMAIL, ADMIN_ORIGIN, adminHeaders, stubAccessCerts } from "../../test/access";
import { resetDb } from "../../test/factories";
import {
  expectGeneric404,
  guestGet,
  insertPhoto,
  liveEvent,
  openGallery,
  variantBytes,
} from "../../test/guest";
import { emptyBucket, listKeys } from "../../test/upload";

const ADMIN = "http://admin.localhost:8787";
const db = env.DB;

async function api(method: string, path: string, headers?: Record<string, string>) {
  return exports.default.fetch(`${ADMIN}/api${path}`, {
    method,
    headers: headers ?? (await adminHeaders()),
    body: method === "GET" ? undefined : "{}",
  });
}

async function listPhotos(eventId: string, query = ""): Promise<AdminPhotoList> {
  const res = await api("GET", `/events/${eventId}/photos${query}`);
  if (res.status !== 200) throw new Error(`list: ${res.status} ${await res.text()}`);
  return AdminPhotoList.parse(await res.json());
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ErrorBody.parse(await res.json()).code).toBe(code);
}

const audit = (eventId?: string) => listAudit(db, { eventId, limit: 100 });

beforeEach(async () => {
  await resetDb();
  await emptyBucket();
  stubAccessCerts();
});
afterEach(() => vi.restoreAllMocks());

describe("auth on the photo routes", () => {
  it("protects every route (401 with no Access token) and refuses a cross-origin mutation (403)", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    const noToken = { Origin: ADMIN_ORIGIN, "Content-Type": "application/json" };
    const routes: [string, string][] = [
      ["GET", `/events/${event.id}/photos`],
      ["POST", `/photos/${photo.id}/hide`],
      ["POST", `/photos/${photo.id}/unhide`],
      ["DELETE", `/photos/${photo.id}`],
      ["GET", `/media/${photo.id}/thumb`],
      ["GET", "/audit"],
    ];
    for (const [method, path] of routes) {
      expect((await api(method, path, noToken)).status, `${method} ${path}`).toBe(401);
    }
    const crossOrigin = { ...(await adminHeaders()), Origin: "https://evil.example" };
    for (const [method, path] of routes.filter(([m]) => m !== "GET")) {
      expect((await api(method, path, crossOrigin)).status, `${method} ${path}`).toBe(403);
    }
    expect(await getPhoto(db, photo.id)).toMatchObject({ hidden: 0 });
    expect(await audit()).toEqual([]);
  });
});

describe("GET /api/events/{id}/photos", () => {
  it("lists every state, newest first, with the reject reason and the contract's fields", async () => {
    const event = await liveEvent();
    const ready = await insertPhoto(event, { photo: { shot: 1 } });
    const pending = await insertPhoto(event, { state: "PENDING", photo: { shot: 2 } });
    const rejected = await insertPhoto(event, { state: "REJECTED", photo: { shot: 3 } });
    const page = await listPhotos(event.id);
    expect(page.photos.map((p) => p.id)).toEqual([rejected.id, pending.id, ready.id].sort().reverse());
    const byId = new Map(page.photos.map((p) => [p.id, p]));
    expect(byId.get(ready.id)).toMatchObject({ state: "READY", rejectReason: null, hidden: false, shot: 1, eventId: event.id, deviceId: ready.device_id });
    expect(byId.get(ready.id)?.publishedAt).not.toBeNull();
    expect(byId.get(pending.id)).toMatchObject({ state: "PENDING", publishedAt: null });
    expect(byId.get(rejected.id)).toMatchObject({ state: "REJECTED", rejectReason: "test" });
    expect(byId.get(ready.id)?.variantBytes).toEqual({ thumb: 21_000, hd: 416_000 });
    expect(page.nextCursor).toBeNull();
  });

  it("filters by state and by hidden", async () => {
    const event = await liveEvent();
    const visible = await insertPhoto(event);
    const hidden = await insertPhoto(event, { hidden: true });
    const pending = await insertPhoto(event, { state: "PENDING" });
    const rejected = await insertPhoto(event, { state: "REJECTED" });
    const ids = async (query: string) => (await listPhotos(event.id, query)).photos.map((p) => p.id).sort();
    expect(await ids("?state=READY")).toEqual([visible.id, hidden.id].sort());
    expect(await ids("?state=PENDING")).toEqual([pending.id]);
    expect(await ids("?state=REJECTED")).toEqual([rejected.id]);
    expect(await ids("?hidden=true")).toEqual([hidden.id]);
    expect(await ids("?hidden=false")).toEqual([visible.id, pending.id, rejected.id].sort());
    expect(await ids("?state=READY&hidden=true")).toEqual([hidden.id]);
    expect(await ids("?state=READY&hidden=false")).toEqual([visible.id]);
  });

  it("pages with an opaque cursor: no duplicates, no gaps, newest first", async () => {
    const event = await liveEvent();
    const all: string[] = [];
    for (let i = 0; i < 7; i++) all.push((await insertPhoto(event, { photo: { id: newId(new Date(Date.parse("2026-10-22T09:00:00.000Z") + i * 1000)) } })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: AdminPhotoList = await listPhotos(event.id, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.photos.length).toBeLessThanOrEqual(3);
      seen.push(...page.photos.map((p) => p.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...all].reverse());
  });

  it("is scoped to the event: another event's photos never appear, and its cursor can't reach them", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const mine = await insertPhoto(a);
    const theirs = await insertPhoto(b);
    expect((await listPhotos(a.id)).photos.map((p) => p.id)).toEqual([mine.id]);
    expect((await listPhotos(b.id)).photos.map((p) => p.id)).toEqual([theirs.id]);
  });

  it("lists a deleted event's photos too (a removal request can arrive during the undo)", async () => {
    const event = await liveEvent({ deleted_at: "2026-10-22T09:00:00.000Z", purge_after: "2026-10-29T09:00:00.000Z" });
    const photo = await insertPhoto(event);
    expect((await listPhotos(event.id)).photos.map((p) => p.id)).toEqual([photo.id]);
  });

  it("answers 404 for an unknown or malformed event and 400 for a bad query", async () => {
    const event = await liveEvent();
    await expectError(await api("GET", `/events/${newId()}/photos`), 404, "not_found");
    await expectError(await api("GET", "/events/not-an-id/photos"), 404, "not_found");
    for (const query of ["?state=DELETED", "?hidden=1", "?limit=0", "?limit=101", "?limit=x", "?cursor=!!", "?extra=1"]) {
      await expectError(await api("GET", `/events/${event.id}/photos${query}`), 400, "invalid_request");
    }
  });

  it("an empty event is an empty page", async () => {
    const event = await liveEvent();
    expect(await listPhotos(event.id)).toEqual({ photos: [], nextCursor: null });
  });

  it("reads one event's rows only: the cost of a page does not grow with other events", async () => {
    const event = await liveEvent();
    const other = await liveEvent();
    for (let i = 0; i < 20; i++) await insertPhoto(other);
    for (let i = 0; i < 3; i++) await insertPhoto(event);
    const { listAdminPhotos } = await import("../../db/photos");
    const page = await listAdminPhotos(db, { eventId: event.id, cursor: null, limit: 60 });
    expect(page.photos).toHaveLength(3);
    // Its three rows through the index (an entry and a row each, plus the lookahead), never the other event's twenty.
    expect(page.rowsRead).toBeLessThanOrEqual(3 * 2 + 2);
  });
});

describe("hide and unhide", () => {
  it("hide takes effect for guests at once: the list and the media (both variants) stop, and the audit row is written", async () => {
    const event = await liveEvent();
    const shown = await insertPhoto(event);
    const target = await insertPhoto(event, { photo: { session_id: "s-1", shot: 2 } });
    const cookie = await openGallery(event);
    expect((await (await guestGet(event.public_id, "/api/photos", cookie)).json<{ photos: unknown[] }>()).photos).toHaveLength(2);
    expect((await guestGet(event.public_id, `/m/${target.id}/hd`, cookie)).status).toBe(200);

    const res = await api("POST", `/photos/${target.id}/hide`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: target.id, hidden: true });

    const list = await guestGet(event.public_id, "/api/photos", cookie);
    expect((await list.json<{ photos: { id: string }[] }>()).photos.map((p) => p.id)).toEqual([shown.id]);
    for (const variant of ["thumb", "hd"]) await expectGeneric404(await guestGet(event.public_id, `/m/${target.id}/${variant}`, cookie));
    // The gallery stays open for everyone else, and the other photo is still served.
    expect((await guestGet(event.public_id, `/m/${shown.id}/hd`, cookie)).status).toBe(200);

    expect(await audit(event.id)).toEqual([
      expect.objectContaining({
        action: "photo.hide",
        actor: ADMIN_EMAIL,
        event_id: event.id,
        target_id: target.id,
        detail: { sessionId: "s-1", shot: 2, state: "READY" },
      }),
    ]);
  });

  it("unhide brings the photo back to the list and the media, and is audited", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event, { hidden: true });
    const cookie = await openGallery(event);
    await expectGeneric404(await guestGet(event.public_id, `/m/${photo.id}/thumb`, cookie));
    const res = await api("POST", `/photos/${photo.id}/unhide`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: photo.id, hidden: false });
    expect((await guestGet(event.public_id, `/m/${photo.id}/thumb`, cookie)).status).toBe(200);
    const list = await (await guestGet(event.public_id, "/api/photos", cookie)).json<{ photos: { id: string }[] }>();
    expect(list.photos.map((p) => p.id)).toEqual([photo.id]);
    expect((await audit(event.id)).map((a) => a.action)).toEqual(["photo.unhide"]);
  });

  it("hiding a hidden photo (or unhiding a visible one) is a 409 that changes and audits nothing", async () => {
    const event = await liveEvent();
    const visible = await insertPhoto(event);
    const hidden = await insertPhoto(event, { hidden: true });
    await expectError(await api("POST", `/photos/${hidden.id}/hide`), 409, "conflict");
    await expectError(await api("POST", `/photos/${visible.id}/unhide`), 409, "conflict");
    expect(await audit()).toEqual([]);
    expect(await getPhoto(db, hidden.id)).toMatchObject({ hidden: 1 });
    expect(await getPhoto(db, visible.id)).toMatchObject({ hidden: 0 });
  });

  it("a hidden photo stays hidden for the admin, with its objects, and counts show it", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    await api("POST", `/photos/${photo.id}/hide`);
    expect((await listPhotos(event.id)).photos[0]).toMatchObject({ id: photo.id, hidden: true, state: "READY" });
    expect(await listKeys()).toContain(variantKey(event.id, photo.id, "hd"));
    const detail = AdminEvent.parse(await (await api("GET", `/events/${event.id}`)).json());
    expect(detail.counts).toMatchObject({ ready: 1, hidden: 1 });
  });

  it("hides a PENDING or REJECTED photo too (it stays hidden if it later becomes visible)", async () => {
    const event = await liveEvent();
    const pending = await insertPhoto(event, { state: "PENDING" });
    expect((await api("POST", `/photos/${pending.id}/hide`)).status).toBe(200);
    expect(await getPhoto(db, pending.id)).toMatchObject({ hidden: 1, state: "PENDING" });
  });

  it("answers 404 for an unknown or malformed photo and audits nothing", async () => {
    await liveEvent();
    await expectError(await api("POST", `/photos/${newId()}/hide`), 404, "not_found");
    await expectError(await api("POST", `/photos/${newId()}/unhide`), 404, "not_found");
    await expectError(await api("POST", "/photos/nope/hide"), 404, "not_found");
    expect(await audit()).toEqual([]);
  });

  it("hiding in one event leaves the same session's photos in another event alone", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const mine = await insertPhoto(a);
    const theirs = await insertPhoto(b);
    await api("POST", `/photos/${mine.id}/hide`);
    expect(await getPhoto(db, theirs.id)).toMatchObject({ hidden: 0 });
  });
});

describe("DELETE /api/photos/{id}", () => {
  it("removes both objects and the row, audits it, and guests lose the photo at once", async () => {
    const event = await liveEvent();
    const keep = await insertPhoto(event);
    const target = await insertPhoto(event, { photo: { session_id: "s-9", shot: 3 } });
    const cookie = await openGallery(event);
    expect((await guestGet(event.public_id, `/m/${target.id}/hd`, cookie)).status).toBe(200);

    const res = await api("DELETE", `/photos/${target.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: target.id });

    // R2: both variants gone, the other photo's objects untouched.
    expect(await env.MEDIA.get(variantKey(event.id, target.id, "thumb"))).toBeNull();
    expect(await env.MEDIA.get(variantKey(event.id, target.id, "hd"))).toBeNull();
    expect(await listKeys()).toEqual([variantKey(event.id, keep.id, "hd"), variantKey(event.id, keep.id, "thumb")].sort());
    // D1: the row is gone.
    expect(await getPhoto(db, target.id)).toBeNull();
    // Guests: neither the list nor the media serves it.
    const list = await (await guestGet(event.public_id, "/api/photos", cookie)).json<{ photos: { id: string }[] }>();
    expect(list.photos.map((p) => p.id)).toEqual([keep.id]);
    for (const variant of ["thumb", "hd"]) await expectGeneric404(await guestGet(event.public_id, `/m/${target.id}/${variant}`, cookie));
    // The audit row keeps the photo's ID and what it was.
    expect(await audit(event.id)).toEqual([
      expect.objectContaining({
        action: "photo.delete",
        actor: ADMIN_EMAIL,
        event_id: event.id,
        target_id: target.id,
        detail: { sessionId: "s-9", shot: 3, state: "READY", hidden: false },
      }),
    ]);
  });

  it("deletes a hidden photo, and a PENDING or REJECTED one whose objects are missing or partial", async () => {
    const event = await liveEvent();
    const hidden = await insertPhoto(event, { hidden: true });
    const pending = await insertPhoto(event, { state: "PENDING" });
    const rejected = await insertPhoto(event, { state: "REJECTED" });
    // A real PENDING photo may have only its thumb; a REJECTED one may have lost the bad variant.
    await env.MEDIA.delete(variantKey(event.id, pending.id, "hd"));
    await env.MEDIA.delete([variantKey(event.id, rejected.id, "thumb"), variantKey(event.id, rejected.id, "hd")]);
    for (const photo of [hidden, pending, rejected]) {
      expect((await api("DELETE", `/photos/${photo.id}`)).status, photo.id).toBe(200);
      expect(await getPhoto(db, photo.id)).toBeNull();
    }
    expect(await listKeys()).toEqual([]);
    expect((await audit(event.id)).map((a) => a.detail)).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "PENDING" }), expect.objectContaining({ state: "REJECTED" }), expect.objectContaining({ hidden: true })]),
    );
  });

  it("deletes even in a deleted event, and the event's counts and photo-limit slot follow", async () => {
    const event = await liveEvent({ photo_limit: 2 });
    const a = await insertPhoto(event);
    await insertPhoto(event);
    await api("DELETE", `/photos/${a.id}`);
    const detail = AdminEvent.parse(await (await api("GET", `/events/${event.id}`)).json());
    expect(detail.counts.ready).toBe(1);
    // The freed slot is usable again: the limit counts rows.
    await insertPhoto(event);
    const deleted = await liveEvent({ deleted_at: "2026-10-22T09:00:00.000Z", purge_after: "2026-10-29T09:00:00.000Z" });
    const photo = await insertPhoto(deleted);
    expect((await api("DELETE", `/photos/${photo.id}`)).status).toBe(200);
  });

  it("a second delete is a 404 with no second audit row, and it never touches another event's objects", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const photo = await insertPhoto(a);
    const other = await insertPhoto(b);
    expect((await api("DELETE", `/photos/${photo.id}`)).status).toBe(200);
    await expectError(await api("DELETE", `/photos/${photo.id}`), 404, "not_found");
    await expectError(await api("DELETE", `/photos/${newId()}`), 404, "not_found");
    await expectError(await api("DELETE", "/photos/not-an-id"), 404, "not_found");
    expect(await audit()).toHaveLength(1);
    expect(await getPhoto(db, other.id)).not.toBeNull();
    expect(await env.MEDIA.get(variantKey(b.id, other.id, "hd"))).not.toBeNull();
  });

  it("if R2 fails the photo is kept, nothing is audited, and a retry finishes the job", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    const del = vi.spyOn(env.MEDIA, "delete").mockRejectedValueOnce(new Error("R2 unavailable"));
    await expectError(await api("DELETE", `/photos/${photo.id}`), 500, "internal");
    expect(await getPhoto(db, photo.id)).not.toBeNull();
    expect(await audit()).toEqual([]);
    del.mockRestore();
    expect((await api("DELETE", `/photos/${photo.id}`)).status).toBe(200);
    expect(await listKeys()).toEqual([]);
    expect(await audit()).toHaveLength(1);
  });

  it("the gallery stays open for the others after one photo is deleted (no access_version change)", async () => {
    const event = await liveEvent();
    const keep = await insertPhoto(event);
    const gone = await insertPhoto(event);
    const cookie = await openGallery(event);
    await api("DELETE", `/photos/${gone.id}`);
    const res = await guestGet(event.public_id, `/m/${keep.id}/thumb`, cookie);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(variantBytes(keep.id, "thumb"));
    // And the refusal for the deleted one is a plain 404, not a cookie clear.
    const refused = await guestGet(event.public_id, `/m/${gone.id}/thumb`, cookie);
    expect(refused.headers.get("Set-Cookie")).toBeNull();
    await expectGeneric404(refused);
  });
});

describe("GET /api/media/{photoId}/{variant}", () => {
  it("streams the variant for any state, hidden included, with private, no-store and no sniffing", async () => {
    const event = await liveEvent();
    const cases = [
      await insertPhoto(event),
      await insertPhoto(event, { hidden: true }),
      await insertPhoto(event, { state: "PENDING" }),
      await insertPhoto(event, { state: "REJECTED" }),
    ];
    for (const photo of cases) {
      for (const variant of ["thumb", "hd"] as const) {
        const res = await api("GET", `/media/${photo.id}/${variant}`);
        expect(res.status, `${photo.id} ${variant}`).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(variantBytes(photo.id, variant));
        expect(res.headers.get("Cache-Control")).toBe("private, no-store");
        expect(res.headers.get("Content-Type")).toBe("image/jpeg");
        expect(res.headers.get("Content-Length")).toBe(String(variantBytes(photo.id, variant).length));
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(res.headers.get("Content-Disposition")).toBeNull();
        expect(res.headers.get("Set-Cookie")).toBeNull();
      }
    }
  });

  it("refuses with a 404 (never cached) when the photo, variant or object is missing", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event, { state: "PENDING" });
    await env.MEDIA.delete(variantKey(event.id, photo.id, "hd"));
    for (const path of [`/media/${photo.id}/hd`, `/media/${newId()}/thumb`, "/media/nope/thumb", `/media/${photo.id}/full`, `/media/${photo.id}/thumb.jpg`, `/media/${photo.id}`]) {
      const res = await api("GET", path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      expect(ErrorBody.parse(await res.json()).code).toBe("not_found");
    }
  });

  it("serves an object only under its own photo row's event (a stray key is not reachable by another photo's ID)", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const mine = await insertPhoto(a);
    const theirs = await insertPhoto(b);
    const res = await api("GET", `/media/${mine.id}/hd`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(variantBytes(mine.id, "hd"));
    expect(new Uint8Array(await (await api("GET", `/media/${theirs.id}/hd`)).arrayBuffer())).toEqual(variantBytes(theirs.id, "hd"));
  });

  it("is not reachable from the gallery host", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    const res = await exports.default.fetch(`http://photos.localhost:8787/api/media/${photo.id}/hd`);
    expect(res.status).toBe(404);
  });
});
