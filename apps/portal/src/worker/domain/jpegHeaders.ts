// The JPEG header walk (DESIGN §9.1, §13, D14; spike RESULTS.md Q10). Pure: bytes in, verdict out,
// no I/O and no HTTP types, so the upload route and a future queue consumer (§9.4) share it.
//
// The Worker never decodes an image. It reads the first 64 KB and the last 2 bytes of a stored
// variant and checks that the object is a baseline JPEG with nothing but the segments the booth's
// encoder writes (crates/photobooth-core/src/variants/segments.rs has the same rules plus a scan
// walk the Worker can't afford):
//
// - SOI first; then only APP0 (JFIF), APP14 (Adobe), DQT, DHT, DRI and exactly one SOF0 (8-bit
//   baseline) before SOS. Everything else fails with a named reason: APP1 (EXIF, XMP), APP2 (ICC,
//   MPF), APP13 (IPTC), COM, other APPn, SOF1 and up (progressive included), fill bytes.
// - Baseline means one scan, so no segment can hide between scans past the walked range.
// - The SOS header ends within the first 64 KB.
// - The object ends in EOI (FFD9). Only the last 2 bytes are read, so a trailer that itself ends
//   in FFD9 passes: that is the accepted residual risk (DESIGN §13).

/** How much of the object the walk reads. */
export const HEADER_WINDOW = 64 * 1024;
/** How much of the object's end is read (the EOI marker). */
export const TAIL_BYTES = 2;

export type HeaderCheck = { ok: true; width: number; height: number } | { ok: false; reason: string };

const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"
const ADOBE = [0x41, 0x64, 0x6f, 0x62, 0x65]; // "Adobe"

const SOF0 = 0xc0;
const SOS = 0xda;
/** DQT, DHT, DRI: tables and the restart interval, allowed without further checks. */
const TABLES = new Set([0xdb, 0xc4, 0xdd]);

function startsWith(payload: Uint8Array, prefix: number[]): boolean {
  return payload.length >= prefix.length && prefix.every((b, i) => payload[i] === b);
}

function hex(marker: number): string {
  return `0x${marker.toString(16).padStart(2, "0")}`;
}

/**
 * Walks the header segments in `head` (the object's first bytes, up to HEADER_WINDOW) and checks
 * that `tail` (its last TAIL_BYTES) is EOI. Returns the SOF size, or the first reason it fails.
 */
export function checkJpegHeaders(head: Uint8Array, tail: Uint8Array): HeaderCheck {
  const fail = (reason: string): HeaderCheck => ({ ok: false, reason });
  const bytes = head.subarray(0, HEADER_WINDOW);
  // The walk ran out of bytes: past the window if it read a full window, else a short object.
  const outOfBytes = () => fail(bytes.length >= HEADER_WINDOW ? "SOS past 64 KB" : "truncated before SOS");

  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return fail("no SOI");
  let frame: { width: number; height: number } | null = null;
  let at = 2;
  for (;;) {
    if (at + 4 > bytes.length) return outOfBytes();
    if (bytes[at] !== 0xff) return fail(`bad marker at ${at}`);
    const marker = bytes[at + 1]!;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2) return fail(`bad segment length at ${at + 2}`);
    const end = at + 2 + length;
    if (end > bytes.length) return outOfBytes();
    const payload = bytes.subarray(at + 4, end);

    if (marker === SOS) {
      if (!frame) return fail("SOS before SOF");
      if (tail.length !== TAIL_BYTES || tail[0] !== 0xff || tail[1] !== 0xd9) return fail("no EOI");
      return { ok: true, ...frame };
    } else if (marker === SOF0) {
      if (frame) return fail("more than one SOF");
      if (payload.length < 5) return fail("truncated before SOS");
      if (payload[0] !== 8) return fail("SOF not 8-bit");
      const height = (payload[1]! << 8) | payload[2]!;
      const width = (payload[3]! << 8) | payload[4]!;
      if (width === 0 || height === 0) return fail("SOF zero size");
      frame = { width, height };
    } else if (marker === 0xe0) {
      if (!startsWith(payload, JFIF)) return fail("APP0 is not JFIF");
    } else if (marker === 0xee) {
      if (!startsWith(payload, ADOBE)) return fail("APP14 is not Adobe");
    } else if (!TABLES.has(marker)) {
      return fail(`segment ${hex(marker)} not allowed`);
    }
    at = end;
  }
}
