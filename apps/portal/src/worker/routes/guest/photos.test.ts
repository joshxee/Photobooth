import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import firstFixture from "../../../../contract/fixtures/gallery.photos-page.first.json";
import lastFixture from "../../../../contract/fixtures/gallery.photos-page.last.json";
import manifest from "../../../../contract/manifest.json";
import { AdminEvent, ErrorBody, GalleryPhotosPage } from "../../../shared/schemas";
import { decodeCursor, encodeCursor } from "../../domain/cursor";
import { newId, newPublicId } from "../../domain/ids";
import { createApp } from "../../app";
import { signGuestCookie } from "../../lib/guestCookie";
import { adminHeaders, stubAccessCerts } from "../../test/access";
import { expectFixtureShape } from "../../test/device";
import { resetDb } from "../../test/factories";
import {
  expectGeneric404,
  expectGuestRefusal,
  guestGet,
  insertPhoto,
  liveEvent,
  openGallery,
  readyPhotos,
} from "../../test/guest";

beforeEach(async () => {
  await resetDb();
  stubAccessCerts();
});
afterEach(() => vi.restoreAllMocks());

async function page(publicId: string, cookie: string, query = ""): Promise<GalleryPhotosPage> {
  const res = await guestGet(publicId, `/api/photos${query}`, cookie);
  if (res.status !== 200) throw new Error(`photos: expected 200, got ${res.status}: ${await res.text()}`);
  return GalleryPhotosPage.parse(await res.json());
}

async function adminAction(eventId: string, action: string): Promise<AdminEvent> {
  const res = await exports.default.fetch(`http://admin.localhost:8787/api/events/${eventId}/${action}`, {
    method: "POST",
    headers: await adminHeaders(),
    body: "{}",
  });
  if (res.status !== 200) throw new Error(`${action}: ${res.status} ${await res.text()}`);
  return AdminEvent.parse(await res.json());
}

/** The access log line for `path`, from a console.log spy. */
function accessLine(spy: { mock: { calls: unknown[][] } }, path: string): Record<string, unknown> {
  const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
  const line = lines.findLast((l) => l.path === path);
  if (!line) throw new Error(`no access log line for ${path}`);
  return line;
}

describe("GET /e/{publicId}/api/photos", () => {
  it("lists the event's READY photos newest first, in the contract's shape", async () => {
    const event = await liveEvent({ name: "Smith wedding" });
    const photos = await readyPhotos(event, 3);
    const cookie = await openGallery(event);
    const res = await guestGet(event.public_id, "/api/photos", cookie);
    expect(res.status).toBe(manifest.fixtures["gallery.photos-page.first.json"].status);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const body = await res.json();
    expectFixtureShape(body, { ...lastFixture, photos: firstFixture.photos });
    expect(GalleryPhotosPage.parse(body)).toEqual({
      eventName: "Smith wedding",
      localDate: "2026-10-22",
      eventOpen: true,
      photos: photos.map((p, i) => ({
        id: p.id,
        sessionId: p.session_id,
        shot: p.shot,
        width: 2560,
        height: 1707,
        publishedAt: new Date(Date.parse("2026-10-22T09:30:00.000Z") + (2 - i) * 1000).toISOString(),
      })),
      nextCursor: null,
      contact: { address: env.CONTACT_ADDRESS, email: env.CONTACT_EMAIL },
    });
  });

  it("matches the first-page fixture when there is a next page, and the last-page one at the end", async () => {
    const event = await liveEvent();
    await readyPhotos(event, 3);
    const cookie = await openGallery(event);
    const first = await guestGet(event.public_id, "/api/photos?limit=2", cookie);
    const firstBody = (await first.json()) as GalleryPhotosPage;
    expectFixtureShape(firstBody, firstFixture);
    expect(firstBody.nextCursor).not.toBeNull();
    const last = await page(event.public_id, cookie, `?limit=2&cursor=${firstBody.nextCursor}`);
    expectFixtureShape(last, { ...lastFixture, photos: firstFixture.photos });
    expect(last.nextCursor).toBeNull();
  });

  it("returns 24 by default and at most 100", async () => {
    const event = await liveEvent();
    await readyPhotos(event, 101);
    const cookie = await openGallery(event);
    expect((await page(event.public_id, cookie)).photos).toHaveLength(24);
    expect((await page(event.public_id, cookie, "?limit=100")).photos).toHaveLength(100);
    expect((await page(event.public_id, cookie, "?limit=1")).photos).toHaveLength(1);
    for (const bad of ["?limit=101", "?limit=0", "?limit=-1", "?limit=abc", "?limit=2.5"]) {
      const res = await guestGet(event.public_id, `/api/photos${bad}`, cookie);
      expect(res.status, bad).toBe(400);
      expect(ErrorBody.parse(await res.json()).code).toBe("invalid_request");
    }
  });

  it("refuses a cursor it didn't make and unknown parameters with 400", async () => {
    const event = await liveEvent();
    const cookie = await openGallery(event);
    for (const bad of ["?cursor=garbage", "?cursor=", `?cursor=${"A".repeat(200)}`, "?session=bad%20id", "?other=1"]) {
      const res = await guestGet(event.public_id, `/api/photos${bad}`, cookie);
      expect(res.status, bad).toBe(400);
      expect(ErrorBody.parse(await res.json()).code).toBe("invalid_request");
    }
  });

  it("never lists hidden, PENDING or REJECTED photos", async () => {
    const event = await liveEvent();
    const visible = await insertPhoto(event);
    await insertPhoto(event, { hidden: true });
    await insertPhoto(event, { state: "PENDING" });
    await insertPhoto(event, { state: "REJECTED" });
    const cookie = await openGallery(event);
    expect((await page(event.public_id, cookie)).photos.map((p) => p.id)).toEqual([visible.id]);
  });

  it("lists only this event's photos (cross-event)", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const mine = await readyPhotos(a, 2);
    await readyPhotos(b, 3);
    const cookie = await openGallery(a);
    expect((await page(a.public_id, cookie)).photos.map((p) => p.id)).toEqual(mine.map((p) => p.id));
  });

  it("filters by session within the event; another event's session ID gives an empty page", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const mine = await readyPhotos(a, 3, "aaaa1111-1");
    await readyPhotos(a, 2, "aaaa1111-2");
    await readyPhotos(b, 2, "bbbb2222-1");
    const cookie = await openGallery(a);
    expect((await page(a.public_id, cookie, "?session=aaaa1111-1")).photos.map((p) => p.id)).toEqual(mine.map((p) => p.id));
    const foreign = await page(a.public_id, cookie, "?session=bbbb2222-1");
    expect(foreign.photos).toEqual([]);
    expect(foreign.nextCursor).toBeNull();
  });

  it("pages stably while new photos arrive", async () => {
    const event = await liveEvent();
    const before = await readyPhotos(event, 7);
    const cookie = await openGallery(event);
    const seen: string[] = [];
    const first = await page(event.public_id, cookie, "?limit=3");
    seen.push(...first.photos.map((p) => p.id));
    // Newer photos arrive between pages; they must not shift what the next page returns.
    await insertPhoto(event, { publishedAt: "2026-10-22T10:00:00.000Z" });
    await insertPhoto(event, { publishedAt: "2026-10-22T10:00:01.000Z" });
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await page(event.public_id, cookie, `?limit=3&cursor=${cursor}`);
      seen.push(...next.photos.map((p) => p.id));
      cursor = next.nextCursor;
    }
    expect(seen).toEqual(before.map((p) => p.id));
    // A fresh first page (what a poll fetches) starts with the new arrivals.
    expect((await page(event.public_id, cookie, "?limit=3")).photos).toHaveLength(3);
  });

  it("orders photos published in the same millisecond by ID, without gaps between pages", async () => {
    const event = await liveEvent();
    const at = "2026-10-22T09:30:00.000Z";
    for (let i = 0; i < 5; i++) await insertPhoto(event, { publishedAt: at });
    const cookie = await openGallery(event);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const next: GalleryPhotosPage = await page(event.public_id, cookie, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...next.photos.map((p) => p.id));
      cursor = next.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("a forged cursor pages only within this event", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const [newestB] = await readyPhotos(b, 2);
    await readyPhotos(a, 1);
    const cookie = await openGallery(a);
    const forged = encodeCursor({ publishedAt: "2099-01-01T00:00:00.000Z", id: newestB!.id });
    expect(decodeCursor(forged)).not.toBeNull();
    const res = await page(a.public_id, cookie, `?cursor=${forged}`);
    expect(res.photos.every((p) => p.id !== newestB!.id)).toBe(true);
    expect(res.photos).toHaveLength(1);
  });

  it("reports eventOpen from the upload state, for the gallery's polling", async () => {
    const cases: [Parameters<typeof liveEvent>[0], boolean][] = [
      [{ upload_status: "OPEN" }, true],
      [{ upload_status: "CLOSED" }, false],
      [{ upload_status: "DRAFT" }, false],
      [{ upload_status: "OPEN", uploads_until: "2026-01-01T00:00:00.000Z" }, false],
    ];
    for (const [overrides, open] of cases) {
      const event = await liveEvent(overrides);
      expect((await page(event.public_id, await openGallery(event))).eventOpen).toBe(open);
    }
  });

  it("answers a 500 and logs an internal error when the contact variables are empty (a config fault, not the client's)", async () => {
    const event = await liveEvent();
    const cookie = await openGallery(event);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const blank of [{ CONTACT_EMAIL: "" }, { CONTACT_ADDRESS: "" }]) {
      const res = await createApp().fetch(
        new Request(`http://photos.localhost:8787/e/${event.public_id}/api/photos`, { headers: { Cookie: cookie } }),
        { ...env, ...blank },
        createExecutionContext(),
      );
      expect(res.status).toBe(500);
      expect(ErrorBody.parse(await res.json()).code).toBe("internal");
    }
    expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])).outcome)).toEqual(["internal_error", "internal_error"]);
  });

  it("still serves a gallery past its upload window (galleries don't expire, D15)", async () => {
    const event = await liveEvent({ upload_status: "CLOSED", uploads_until: "2026-01-01T00:00:00.000Z" });
    await readyPhotos(event, 1);
    expect((await page(event.public_id, await openGallery(event))).photos).toHaveLength(1);
  });

  it("reads one event row and about one page of photo rows (D1 bills rows read)", async () => {
    const event = await liveEvent();
    await readyPhotos(event, 60, "big00000-1");
    const mine = await readyPhotos(event, 3, "mine0000-1");
    const cookie = await openGallery(event);
    const spy = vi.spyOn(console, "log");
    const path = `/e/${event.public_id}/api/photos`;

    // The event row, the page, one row to know there's a next page, and (after a cursor) the
    // boundary row the index seek lands on.
    const first = await page(event.public_id, cookie);
    expect(accessLine(spy, path)).toMatchObject({ eventId: event.id, rowsRead: expect.any(Number) });
    expect(accessLine(spy, path).rowsRead).toBeLessThanOrEqual(1 + 24 + 1);

    await page(event.public_id, cookie, `?cursor=${first.nextCursor}`);
    expect(accessLine(spy, path).rowsRead).toBeLessThanOrEqual(1 + 24 + 2);

    // The post-shoot view polls its own session every 10 s: that must not scan the whole event.
    const session = await page(event.public_id, cookie, "?session=mine0000-1");
    expect(session.photos.map((p) => p.id)).toEqual(mine.map((p) => p.id));
    expect(accessLine(spy, path).rowsRead).toBeLessThanOrEqual(1 + 4);
  });
});

describe("guest session check (middleware/guestAuth)", () => {
  it("refuses a request without a valid cookie with the same 404, and clears the cookie", async () => {
    const event = await liveEvent();
    const other = await liveEvent();
    const valid = await openGallery(event);
    const key = env.SESSION_KEY;
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const cookies = [
      undefined,
      "g=",
      "g=garbage",
      `g=${valid.slice(2, -1)}`,
      `${valid}x`,
      `g=${await signGuestCookie(key, { eventId: event.id, accessVersion: 1 }, longAgo)}`,
      `g=${await signGuestCookie(key, { eventId: event.id, accessVersion: 2 }, new Date())}`,
      `g=${await signGuestCookie(key, { eventId: other.id, accessVersion: 1 }, new Date())}`,
      `g=${await signGuestCookie("another-session-key-not-a-secret-0123456789", { eventId: event.id, accessVersion: 1 }, new Date())}`,
      await openGallery(other),
      `other=${valid.slice(2)}`,
    ];
    for (const cookie of cookies) await expectGuestRefusal(await guestGet(event.public_id, "/api/photos", cookie), event.public_id);
    // The cookie belongs to the path it was issued for: event A's cookie means nothing for another event.
    const unknown = newPublicId();
    await expectGuestRefusal(await guestGet(unknown, "/api/photos", valid), unknown);
  });

  it("takes effect on the very next request after rotation; the new link's cookie works", async () => {
    const event = await liveEvent();
    const before = await openGallery(event);
    expect((await guestGet(event.public_id, "/api/photos", before)).status).toBe(200);
    const rotated = await adminAction(event.id, "rotate-link");
    await expectGuestRefusal(await guestGet(event.public_id, "/api/photos", before), event.public_id);
    const after = await openGallery({ public_id: event.public_id, share_token: new URL(rotated.galleryUrl).hash.replace("#k=", "") });
    expect((await guestGet(event.public_id, "/api/photos", after)).status).toBe(200);
  });

  it("takes effect on the very next request after suspension, and publishing again restores the same link", async () => {
    const event = await liveEvent();
    const cookie = await openGallery(event);
    expect((await guestGet(event.public_id, "/api/photos", cookie)).status).toBe(200);
    await adminAction(event.id, "suspend");
    await expectGuestRefusal(await guestGet(event.public_id, "/api/photos", cookie), event.public_id);
    // Suspension hides the gallery; only rotation revokes links (D10: access_version).
    await adminAction(event.id, "publish");
    expect((await guestGet(event.public_id, "/api/photos", cookie)).status).toBe(200);
  });

  it("takes effect on the very next request after the event is deleted", async () => {
    const event = await liveEvent();
    const cookie = await openGallery(event);
    await adminAction(event.id, "delete");
    await expectGuestRefusal(await guestGet(event.public_id, "/api/photos", cookie), event.public_id);
  });

  it("refuses a malformed publicId without echoing it into a Set-Cookie", async () => {
    const event = await liveEvent();
    const cookie = await openGallery(event);
    for (const bad of ["x%3B%20Domain%3Dexample.com", event.public_id.toUpperCase(), event.public_id.slice(1), `${event.public_id}a`, "abcdefghijklmno1"]) {
      const res = await guestGet(bad, "/api/photos", cookie);
      expect(res.headers.get("Set-Cookie"), bad).toBeNull();
      await expectGeneric404(res);
    }
  });

  it("doesn't touch D1 for a cookie that fails its signature", async () => {
    const event = await liveEvent();
    const spy = vi.spyOn(console, "log");
    await guestGet(event.public_id, "/api/photos", `g=${event.id}.1.9999999999.${"A".repeat(43)}`);
    expect(accessLine(spy, `/e/${event.public_id}/api/photos`).rowsRead).toBeUndefined();
  });

  it("answers unknown routes under an event's API with a plain 404, not the SPA", async () => {
    const event = await liveEvent();
    const cookie = await openGallery(event);
    for (const path of ["/api/photos/extra", "/api/other", "/api/", "/m/", `/m/${newId()}`, `/m/${newId()}/hd/x`]) {
      const res = await guestGet(event.public_id, path, cookie);
      await expectGeneric404(res);
    }
  });

  it("is only on the gallery host", async () => {
    const event = await liveEvent();
    const cookie = await openGallery(event);
    const res = await exports.default.fetch(`http://admin.localhost:8787/e/${event.public_id}/api/photos`, {
      headers: { ...(await adminHeaders()), Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });
});
