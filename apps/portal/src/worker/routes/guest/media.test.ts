import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminEvent } from "../../../shared/schemas";
import { newId } from "../../domain/ids";
import { variantKey } from "../../domain/media";
import { adminHeaders, stubAccessCerts } from "../../test/access";
import { resetDb } from "../../test/factories";
import { expectGeneric404, expectGuestRefusal, guestGet, insertPhoto, liveEvent, openGallery, variantBytes } from "../../test/guest";

beforeEach(async () => {
  await resetDb();
  stubAccessCerts();
});
afterEach(() => vi.restoreAllMocks());

async function adminAction(eventId: string, action: string): Promise<AdminEvent> {
  const res = await exports.default.fetch(`http://admin.localhost:8787/api/events/${eventId}/${action}`, {
    method: "POST",
    headers: await adminHeaders(),
    body: "{}",
  });
  if (res.status !== 200) throw new Error(`${action}: ${res.status} ${await res.text()}`);
  return AdminEvent.parse(await res.json());
}

const IMMUTABLE = "private, max-age=31536000, immutable";

describe("GET /e/{publicId}/m/{photoId}/{variant}", () => {
  it("streams each variant from R2 with immutable private caching and the security headers", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    const cookie = await openGallery(event);
    for (const variant of ["thumb", "hd"] as const) {
      const res = await guestGet(event.public_id, `/m/${photo.id}/${variant}`, cookie);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(variantBytes(photo.id, variant));
      expect(res.headers.get("Content-Type")).toBe("image/jpeg");
      expect(res.headers.get("Content-Length")).toBe(String(variantBytes(photo.id, variant).length));
      expect(res.headers.get("Cache-Control")).toBe(IMMUTABLE);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
      expect(res.headers.get("Content-Disposition")).toBeNull();
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("?download=1 adds an attachment with a safe ASCII filename", async () => {
    const event = await liveEvent({ name: "Zoë & Mātene's Wedding" });
    const photo = await insertPhoto(event, { photo: { session_id: "6a3f1c20-3", shot: 2 } });
    const cookie = await openGallery(event);
    const res = await guestGet(event.public_id, `/m/${photo.id}/hd?download=1`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="zoe-matene-s-wedding-6a3f1c20-3-2.jpg"');
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe(IMMUTABLE);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(variantBytes(photo.id, "hd"));
    for (const other of ["?download=0", "?download=true", "?download", "?x=1"]) {
      const inline = await guestGet(event.public_id, `/m/${photo.id}/hd${other}`, cookie);
      expect(inline.status, other).toBe(200);
      expect(inline.headers.get("Content-Disposition"), other).toBeNull();
      await inline.arrayBuffer();
    }
  });

  it("serves only thumb and hd; any other variant is the generic 404", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    await env.MEDIA.put(`events/${event.id}/${photo.id}/full.jpg`, "x");
    const cookie = await openGallery(event);
    for (const variant of ["full", "HD", "thumb.jpg", "hd.jpg", "original", "%2e%2e", "thumb%2F..%2Fhd"]) {
      await expectGeneric404(await guestGet(event.public_id, `/m/${photo.id}/${variant}`, cookie));
    }
  });

  it("never serves hidden, PENDING or REJECTED photos, though their objects exist", async () => {
    const event = await liveEvent();
    const cookie = await openGallery(event);
    for (const opts of [{ hidden: true }, { state: "PENDING" as const }, { state: "REJECTED" as const }]) {
      const photo = await insertPhoto(event, opts);
      expect(await env.MEDIA.head(variantKey(event.id, photo.id, "thumb"))).not.toBeNull();
      for (const variant of ["thumb", "hd"]) {
        const res = await guestGet(event.public_id, `/m/${photo.id}/${variant}`, cookie);
        expect(res.headers.get("Set-Cookie")).toBeNull();
        await expectGeneric404(res);
      }
    }
  });

  it("refuses another event's photo under this event's path (cross-event)", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const photoB = await insertPhoto(b);
    const cookieA = await openGallery(a);
    const cookieB = await openGallery(b);
    // B's photo with A's cookie, under A's path.
    await expectGeneric404(await guestGet(a.public_id, `/m/${photoB.id}/thumb`, cookieA));
    // B's own cookie, sent to A's path, doesn't open A.
    await expectGuestRefusal(await guestGet(a.public_id, `/m/${photoB.id}/thumb`, cookieB), a.public_id);
    // Under B's path with B's cookie it is served.
    expect((await guestGet(b.public_id, `/m/${photoB.id}/thumb`, cookieB)).status).toBe(200);
    // The R2 key holds the event ID too, but the row check refuses on its own: even with an object
    // under A's prefix, B's photo is not A's.
    await env.MEDIA.put(variantKey(a.id, photoB.id, "thumb"), "stray");
    await expectGeneric404(await guestGet(a.public_id, `/m/${photoB.id}/thumb`, cookieA));
  });

  it("refuses an unknown or malformed photo ID, and a READY photo whose object is missing", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    await env.MEDIA.delete(variantKey(event.id, photo.id, "hd"));
    const cookie = await openGallery(event);
    await expectGeneric404(await guestGet(event.public_id, `/m/${newId()}/thumb`, cookie));
    await expectGeneric404(await guestGet(event.public_id, `/m/not-an-id/thumb`, cookie));
    await expectGeneric404(await guestGet(event.public_id, `/m/${photo.id.toUpperCase()}/thumb`, cookie));
    await expectGeneric404(await guestGet(event.public_id, `/m/${photo.id}/hd`, cookie));
    expect((await guestGet(event.public_id, `/m/${photo.id}/thumb`, cookie)).status).toBe(200);
  });

  it("requires the session: no cookie, rotated, suspended or deleted → the 404 that clears the cookie", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    const path = `/m/${photo.id}/thumb`;
    const cookie = await openGallery(event);
    await expectGuestRefusal(await guestGet(event.public_id, path), event.public_id);
    expect((await guestGet(event.public_id, path, cookie)).status).toBe(200);

    await adminAction(event.id, "suspend");
    await expectGuestRefusal(await guestGet(event.public_id, path, cookie), event.public_id);
    await adminAction(event.id, "publish");
    expect((await guestGet(event.public_id, path, cookie)).status).toBe(200);

    await adminAction(event.id, "rotate-link");
    await expectGuestRefusal(await guestGet(event.public_id, path, cookie), event.public_id);

    const other = await liveEvent();
    const otherPhoto = await insertPhoto(other);
    const otherCookie = await openGallery(other);
    await adminAction(other.id, "delete");
    await expectGuestRefusal(await guestGet(other.public_id, `/m/${otherPhoto.id}/hd`, otherCookie), other.public_id);
  });

  it("still serves past the upload window (galleries don't expire, D15)", async () => {
    const event = await liveEvent({ upload_status: "CLOSED", uploads_until: "2026-01-01T00:00:00.000Z" });
    const photo = await insertPhoto(event);
    expect((await guestGet(event.public_id, `/m/${photo.id}/hd`, await openGallery(event))).status).toBe(200);
  });

  it("reads two D1 rows (event and photo) and logs the IDs", async () => {
    const event = await liveEvent();
    const photo = await insertPhoto(event);
    const cookie = await openGallery(event);
    const spy = vi.spyOn(console, "log");
    const path = `/e/${event.public_id}/m/${photo.id}/hd`;
    await (await guestGet(event.public_id, `/m/${photo.id}/hd`, cookie)).arrayBuffer();
    const line = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).findLast((l) => l.path === path);
    expect(line).toMatchObject({ eventId: event.id, photoId: photo.id, status: 200 });
    expect(line!.rowsRead).toBeLessThanOrEqual(2);
  });
});
