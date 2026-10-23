// The guest cookie (DESIGN §11, D10): a stateless, signed grant to one event's gallery. No
// session table: the cookie names the event and the `access_version` it was issued under, and
// every request compares that with the event row, so rotating the link (which bumps the version)
// or suspending the gallery takes effect on the next request.
//
// Value: `{eventId}.{accessVersion}.{exp}.{sig}`, sig = HMAC-SHA256(SESSION_KEY,
// `eventId|accessVersion|exp`), base64url. The fields are in clear so the signature can be checked
// before any D1 read: a forged cookie costs no database rows.
import { hmacBase64url, timingSafeEqual } from "../domain/tokens";

export const GUEST_COOKIE = "g";
/** 30 days (D15: galleries don't expire, so a guest coming back next week needn't rescan the QR). */
export const GUEST_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** SESSION_KEY must be at least this long (a random 32-byte value, base64 or hex encoded). */
const MIN_KEY_LENGTH = 32;

export interface GuestGrant {
  eventId: string;
  accessVersion: number;
}

const VALUE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/;

function sign(key: string, eventId: string, accessVersion: number, exp: number): Promise<string> {
  return hmacBase64url(key, `${eventId}|${accessVersion}|${exp}`, "SESSION_KEY", MIN_KEY_LENGTH);
}

export async function signGuestCookie(key: string, grant: GuestGrant, now: Date): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + GUEST_COOKIE_MAX_AGE_SECONDS;
  return `${grant.eventId}.${grant.accessVersion}.${exp}.${await sign(key, grant.eventId, grant.accessVersion, exp)}`;
}

/**
 * The grant, or null for anything that isn't an unexpired cookie this Worker signed. The caller
 * still checks it against the event row (same event, same access version, gallery visible).
 */
export async function verifyGuestCookie(key: string, value: string, now: Date): Promise<GuestGrant | null> {
  const match = VALUE.exec(value);
  if (!match) {
    // Still check the key, so a missing SESSION_KEY fails closed whatever the request sends.
    await sign(key, "", 0, 0);
    return null;
  }
  const [, eventId, version, exp, sig] = match as unknown as [string, string, string, string, string];
  const expected = await sign(key, eventId, Number(version), Number(exp));
  if (!timingSafeEqual(expected, sig)) return null;
  if (now.getTime() >= Number(exp) * 1000) return null;
  return { eventId, accessVersion: Number(version) };
}

const ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax";

/**
 * Set-Cookie for the event's path only, so each event a guest opens has its own cookie and none
 * is sent anywhere else. `publicId` must already be validated (it goes into the header as is).
 */
export function guestCookie(publicId: string, value: string): string {
  return `${GUEST_COOKIE}=${value}; Max-Age=${GUEST_COOKIE_MAX_AGE_SECONDS}; Path=/e/${publicId}; ${ATTRIBUTES}`;
}

export function clearGuestCookie(publicId: string): string {
  return `${GUEST_COOKIE}=; Max-Age=0; Path=/e/${publicId}; ${ATTRIBUTES}`;
}
