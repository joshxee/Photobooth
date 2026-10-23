// R2 object keys (DESIGN §7, D6). One bucket, `events/` prefix only, fixed keys per photo: a
// retried upload overwrites the same object, and purging an event is one prefix delete.
import type { Variant } from "../../shared/schemas";

/** Every object of an event lives under this prefix; the slash keeps `events/e1/` from matching `events/e10/`. */
export function eventPrefix(eventId: string): string {
  return `events/${eventId}/`;
}

export function variantKey(eventId: string, photoId: string, variant: Variant): string {
  return `${eventPrefix(eventId)}${photoId}/${variant}.jpg`;
}

/** The slug part of a download filename, at most this long. */
const SLUG_MAX = 40;

/**
 * A download's filename (DESIGN §11): `<event-slug>-<session>-<shot>.jpg`. ASCII letters, digits and
 * dashes only (accents folded, anything else collapsed to one dash), so it needs no escaping in
 * `Content-Disposition` and is safe on every OS. Session and shot keep a guest's downloads apart and
 * in order; the session ID is already `[A-Za-z0-9_-]` (SessionId).
 */
export function downloadFilename(eventName: string, sessionId: string, shot: number): string {
  const slug =
    eventName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX)
      .replace(/-+$/, "") || "photo";
  return `${slug}-${sessionId}-${shot}.jpg`;
}
