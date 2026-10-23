const encoder = new TextEncoder();

/** SHA-256 hex of a secret. Device credentials and enrolment codes are stored only as this. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison (for the share token, and hashes or signatures). Only the
 * length can leak, which is fixed for every secret we compare.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) {
    // Still do the work, so a length mismatch takes as long as a content mismatch.
    crypto.subtle.timingSafeEqual(left, left);
    return false;
  }
  return crypto.subtle.timingSafeEqual(left, right);
}

/**
 * HMAC-SHA256 of `message`, base64url without padding (43 characters). For the Worker-signed
 * values (upload URLs, guest cookies). Throws if the key is shorter than `minKeyLength`, so a
 * missing secret fails closed; `name` is the secret's name, for that error.
 */
export async function hmacBase64url(key: string, message: string, name: string, minKeyLength = 32): Promise<string> {
  if (key.length < minKeyLength) throw new Error(`${name} is missing or too short`);
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
