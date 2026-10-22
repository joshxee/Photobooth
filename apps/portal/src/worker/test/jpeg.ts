// Crafted JPEGs for the header-walk and upload tests (session 06). Everything starts from
// scripts/solidJpeg.ts (a valid baseline JPEG: SOI, APP0 JFIF, DQT, SOF0, DHT, SOS, scan, EOI) and
// splices segments in or out, so no image library and no real photo is involved.
import { solidJpeg } from "../../../scripts/solidJpeg";

export { solidJpeg };

/** A valid baseline JPEG of this size (solid grey). */
export function baseline(width = 64, height = 48): Uint8Array {
  return solidJpeg(width, height, [128, 128, 128]);
}

export function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One marker segment: FF, marker, a big-endian length (payload + 2), the payload. */
export function segment(marker: number, payload: Uint8Array | number[]): Uint8Array {
  const length = payload.length + 2;
  return concat([0xff, marker, length >> 8, length & 0xff], payload);
}

export function ascii(text: string): number[] {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}

/** Where the segment with this marker starts (its FF), walking the header segments. */
export function segmentOffset(jpeg: Uint8Array, marker: number): number {
  let at = 2;
  while (at + 4 <= jpeg.length) {
    if (jpeg[at + 1] === marker) return at;
    if (jpeg[at + 1] === 0xda) break;
    at += 2 + ((jpeg[at + 2]! << 8) | jpeg[at + 3]!);
  }
  throw new Error(`no segment 0x${marker.toString(16)}`);
}

function segmentEnd(jpeg: Uint8Array, at: number): number {
  return at + 2 + ((jpeg[at + 2]! << 8) | jpeg[at + 3]!);
}

/** Inserts segments right after the segment with marker `after` (APP0 by default). */
export function insertAfter(jpeg: Uint8Array, segments: Uint8Array[], after = 0xe0): Uint8Array {
  const at = segmentEnd(jpeg, segmentOffset(jpeg, after));
  return concat(jpeg.subarray(0, at), ...segments, jpeg.subarray(at));
}

/** Inserts segments right before the segment with marker `before`. */
export function insertBefore(jpeg: Uint8Array, segments: Uint8Array[], before: number): Uint8Array {
  const at = segmentOffset(jpeg, before);
  return concat(jpeg.subarray(0, at), ...segments, jpeg.subarray(at));
}

/** Removes the segment with this marker. */
export function remove(jpeg: Uint8Array, marker: number): Uint8Array {
  const at = segmentOffset(jpeg, marker);
  return concat(jpeg.subarray(0, at), jpeg.subarray(segmentEnd(jpeg, at)));
}

/** Changes one segment's marker byte (SOF0 → SOF2 makes a "progressive" header). */
export function retag(jpeg: Uint8Array, from: number, to: number): Uint8Array {
  const copy = jpeg.slice();
  copy[segmentOffset(jpeg, from) + 1] = to;
  return copy;
}

/** Replaces one segment's payload. */
export function replacePayload(jpeg: Uint8Array, marker: number, payload: Uint8Array | number[]): Uint8Array {
  const at = segmentOffset(jpeg, marker);
  return concat(jpeg.subarray(0, at), segment(marker, payload), jpeg.subarray(segmentEnd(jpeg, at)));
}

/** A GPS + camera-serial EXIF APP1, as a camera writes it (TIFF little-endian, IFD0 → GPS IFD). */
export function gpsExifSegment(): Uint8Array {
  const tiff = [
    ...ascii("II"), 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    // IFD0: 2 entries: BodySerialNumber (0xa431, ASCII) and GPSInfo (0x8825, LONG → offset 38).
    0x02, 0x00,
    0x31, 0xa4, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, ...ascii("123\0"),
    0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    // GPS IFD: GPSLatitudeRef = "S".
    0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, ...ascii("S\0"), 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  return segment(0xe1, [...ascii("Exif\0\0"), ...tiff]);
}

/** An XMP APP1 packet with a GPS position. */
export function xmpSegment(): Uint8Array {
  return segment(0xe1, [
    ...ascii("http://ns.adobe.com/xap/1.0/\0"),
    ...ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/"><exif:GPSLatitude>36,51.0S</exif:GPSLatitude></x:xmpmeta>'),
  ]);
}

/** A minimal PNG signature plus IHDR: what a PNG renamed to .jpg starts with. */
export function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR"), 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
