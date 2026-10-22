// ID and secret generation (pure: randomness from crypto.getRandomValues, no I/O).
// The scheme and its reasons are in wiki/Portal.md → "IDs and secrets".

const BASE32_LOWER = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648, lowercase for URLs
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O or U: typed by people

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** One character per random byte. 256 is a multiple of 32, so `byte & 31` has no bias. */
function randomChars(alphabet: string, length: number): string {
  let out = "";
  for (const byte of randomBytes(length)) out += alphabet[byte & 31];
  return out;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Row primary key: UUIDv7 (RFC 9562), 48-bit Unix ms timestamp then 74 random bits. */
export function newId(now: Date = new Date()): string {
  const bytes = randomBytes(16);
  let ms = now.getTime();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The event's ID in gallery URLs: 16 base32 characters (80 bits), unguessable. */
export function newPublicId(): string {
  return randomChars(BASE32_LOWER, 16);
}

/** Could this be a `public_id`? Checked before one goes into a query or a cookie's Path. */
export function isPublicId(s: string): boolean {
  return /^[a-z2-7]{16}$/.test(s);
}

/** The gallery share token (`#k=`): 128 bits, base64url (22 characters). */
export function newShareToken(): string {
  return base64url(randomBytes(16));
}

/** The device bearer credential: 256 bits, base64url (43 characters). Stored only as a hash. */
export function newDeviceCredential(): string {
  return base64url(randomBytes(32));
}

/** The one-time enrolment code: 8 Crockford base32 characters (40 bits), typed on the booth. */
export function newEnrolCode(): string {
  return randomChars(CROCKFORD, 8);
}

/**
 * Normalises a typed enrolment code: case-insensitive, spaces and dashes ignored, and the
 * Crockford look-alikes I/L → 1 and O → 0. Returns null if the result can't be a code.
 */
export function normaliseEnrolCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : null;
}
