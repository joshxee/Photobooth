// Worker-signed upload URLs (DESIGN D4, §9.1, §13 "Upload URL replay"). The intent hands the booth
// one descriptor per variant still missing; the PUT is authorised by the URL alone.
//
// The signature is HMAC-SHA256 with the UPLOAD_KEY secret over `photoId|variant|bytes|sha256|exp`,
// so a URL is good for one variant of one photo, with exactly the declared bytes, for 15 minutes.
// The bytes and hash are not in the URL: the PUT route reads them from the photo row and recomputes.
//
// The booth treats the descriptor as opaque (method, url, headers, expiresAt), so `UploadSigner`
// is the seam where SigV4 presigning for R2 can replace this without an app release (§9.4).
import type { UploadDescriptor, Variant } from "../../shared/schemas";
import { timingSafeEqual } from "../domain/tokens";

export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** UPLOAD_KEY must be at least this long (a random 32-byte value, base64 or hex encoded). */
const MIN_KEY_LENGTH = 32;

export interface UploadTarget {
  photoId: string;
  variant: Variant;
  /** The declared size: the PUT's Content-Length must equal it. */
  bytes: number;
  sha256: string;
}

/** Makes the descriptor for one variant's upload. */
export interface UploadSigner {
  sign(target: UploadTarget, now: Date): Promise<UploadDescriptor>;
}

export type UrlVerdict = "valid" | "invalid" | "expired";

const encoder = new TextEncoder();

async function hmac(key: string, message: string): Promise<string> {
  if (key.length < MIN_KEY_LENGTH) throw new Error("UPLOAD_KEY is missing or too short");
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function message(t: UploadTarget, exp: number): string {
  return `${t.photoId}|${t.variant}|${t.bytes}|${t.sha256}|${exp}`;
}

export function uploadPath(photoId: string, variant: Variant): string {
  return `/v1/device/uploads/${photoId}/${variant}`;
}

/** `origin` is the gallery host's origin (`https://photos.<domain>`), where the PUT route lives. */
export function hmacUploadSigner(key: string, origin: string): UploadSigner {
  return {
    async sign(target, now) {
      const exp = Math.floor(now.getTime() / 1000) + UPLOAD_URL_TTL_SECONDS;
      const sig = await hmac(key, message(target, exp));
      return {
        method: "PUT",
        url: `${origin}${uploadPath(target.photoId, target.variant)}?exp=${exp}&sig=${sig}`,
        headers: { "Content-Type": "image/jpeg" },
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    },
  };
}

/**
 * Checks a PUT's `exp` and `sig` against the photo row's declaration. The signature is checked
 * first, in constant time, so a tampered expiry is "invalid" whether or not it is in the past;
 * only a genuine URL can be "expired".
 */
export async function verifyUploadUrl(
  key: string,
  target: UploadTarget,
  query: { exp: string | undefined; sig: string | undefined },
  now: Date,
): Promise<UrlVerdict> {
  const { exp, sig } = query;
  // Canonical decimal only, so one expiry has exactly one signed spelling.
  if (exp === undefined || sig === undefined || !/^[1-9][0-9]{0,11}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) {
    return "invalid";
  }
  const expected = await hmac(key, message(target, Number(exp)));
  if (!timingSafeEqual(expected, sig)) return "invalid";
  return now.getTime() >= Number(exp) * 1000 ? "expired" : "valid";
}
