// Guest API test helpers (session 11): an event with READY photos and their objects in R2, the
// token → cookie swap, and requests carrying the cookie.
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { ErrorBody } from "../../shared/schemas";
import { type EventRow, insertEvent } from "../db/events";
import { insertPhotoIfUnderLimit, type NewPhoto } from "../db/photos";
import { variantKey } from "../domain/media";
import { GALLERY } from "./device";
import { eventRow, photoRow } from "./factories";

const db = env.DB;

export async function liveEvent(overrides: Partial<EventRow> = {}): Promise<EventRow> {
  const event = eventRow(overrides);
  await insertEvent(db, event).run();
  return event;
}

/** Bytes that stand in for a variant: the media route streams whatever R2 holds. */
export function variantBytes(photoId: string, variant: "thumb" | "hd"): Uint8Array {
  return new TextEncoder().encode(`${variant} of ${photoId}`);
}

const DEVICE_ID = "00000000-0000-7000-8000-000000000001";

/**
 * A photo straight into D1 in the given state (READY by default, published at `publishedAt`),
 * with both variants in R2, taken by one shared test device.
 */
export async function insertPhoto(
  event: Pick<EventRow, "id">,
  opts: { state?: "READY" | "PENDING" | "REJECTED"; publishedAt?: string; hidden?: boolean; photo?: Partial<NewPhoto> } = {},
): Promise<NewPhoto> {
  await db.prepare("INSERT OR IGNORE INTO devices (id, name) VALUES (?, 'Booth 1')").bind(DEVICE_ID).run();
  const photo = photoRow({ event_id: event.id, device_id: DEVICE_ID, ...opts.photo });
  const inserted = await insertPhotoIfUnderLimit(db, photo);
  if (inserted.outcome !== "created") throw new Error(`insertPhoto: ${inserted.outcome}`);
  const state = opts.state ?? "READY";
  if (state === "READY") {
    await db
      .prepare("UPDATE photos SET thumb_stored = 1, hd_stored = 1, state = 'READY', published_at = ? WHERE id = ?")
      .bind(opts.publishedAt ?? new Date().toISOString(), photo.id)
      .run();
  } else if (state === "REJECTED") {
    await db.prepare("UPDATE photos SET thumb_stored = 1, state = 'REJECTED', reject_reason = 'test' WHERE id = ?").bind(photo.id).run();
  }
  if (opts.hidden) await db.prepare("UPDATE photos SET hidden = 1 WHERE id = ?").bind(photo.id).run();
  for (const variant of ["thumb", "hd"] as const) {
    await env.MEDIA.put(variantKey(event.id, photo.id, variant), variantBytes(photo.id, variant), {
      httpMetadata: { contentType: "image/jpeg" },
    });
  }
  return photo;
}

/** `count` READY photos, one second apart (oldest first), returned newest first. */
export async function readyPhotos(event: Pick<EventRow, "id">, count: number, sessionId = "19a0b6c1-1"): Promise<NewPhoto[]> {
  const base = Date.parse("2026-10-22T09:30:00.000Z");
  const photos: NewPhoto[] = [];
  for (let i = 0; i < count; i++) {
    photos.push(await insertPhoto(event, { publishedAt: new Date(base + i * 1000).toISOString(), photo: { session_id: sessionId, shot: i % 4 } }));
  }
  return photos.reverse();
}

/** Each request from its own address (10.11.x.x is the guest tests'), so the limiter's state never leaks between tests. */
let ips = 0;
export const freshIp = () => `10.11.${Math.floor(++ips / 256) % 256}.${ips % 256}`;

export function postSession(publicId: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`${GALLERY}/e/${publicId}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshIp(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The `g=…` pair from a session response's Set-Cookie, ready for a Cookie header. */
export function cookieFrom(res: Response): string {
  const header = res.headers.get("Set-Cookie");
  if (!header) throw new Error("no Set-Cookie");
  return header.split(";")[0]!;
}

/** Swaps the event's share token for its cookie; fails the test unless that works. */
export async function openGallery(event: Pick<EventRow, "public_id" | "share_token">): Promise<string> {
  const res = await postSession(event.public_id, { token: event.share_token });
  if (res.status !== 200) throw new Error(`session: expected 200, got ${res.status}: ${await res.text()}`);
  return cookieFrom(res);
}

/** A GET under the event's path (`/api/photos?…` or `/m/{id}/{variant}`) with the cookie. */
export function guestGet(publicId: string, path: string, cookie?: string): Promise<Response> {
  return exports.default.fetch(`${GALLERY}/e/${publicId}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}

/** The one 404 every refusal gets: same status, code, message and caching, nothing else to tell apart. */
export async function expectGeneric404(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const body = ErrorBody.parse(await res.json());
  expect({ code: body.code, message: body.message }).toEqual({ code: "not_found", message: "Not found." });
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
}

/** A refusal from the session middleware also clears the event's cookie. */
export async function expectGuestRefusal(res: Response, publicId: string): Promise<void> {
  expect(res.headers.get("Set-Cookie")).toBe(`g=; Max-Age=0; Path=/e/${publicId}; HttpOnly; Secure; SameSite=Lax`);
  await expectGeneric404(res);
}
