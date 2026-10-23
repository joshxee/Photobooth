import { describe, expect, it } from "vitest";
import {
  ascii,
  baseline,
  concat,
  gpsExifSegment,
  insertAfter,
  insertBefore,
  pngBytes,
  remove,
  replacePayload,
  retag,
  segment,
  segmentOffset,
  xmpSegment,
} from "../test/jpeg";
import { checkJpegHeaders, HEADER_WINDOW, type HeaderCheck, TAIL_BYTES } from "./jpegHeaders";

/** What processPhoto reads from R2: the first 64 KB and the last 2 bytes. */
function walk(bytes: Uint8Array): HeaderCheck {
  return checkJpegHeaders(bytes.subarray(0, HEADER_WINDOW), bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)));
}

function rejected(bytes: Uint8Array): string {
  const result = walk(bytes);
  if (result.ok) throw new Error("expected a rejection");
  return result.reason;
}

const adobe = segment(0xee, [...ascii("Adobe"), 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01]);
const dri = segment(0xdd, [0x00, 0x10]);

describe("checkJpegHeaders accepts", () => {
  it("a valid baseline JFIF and returns its SOF size", () => {
    expect(walk(baseline(64, 48))).toEqual({ ok: true, width: 64, height: 48 });
    expect(walk(baseline(1707, 2560))).toEqual({ ok: true, width: 1707, height: 2560 });
  });

  it("APP14 (Adobe) and DRI, the rest of the allowlist", () => {
    expect(walk(insertAfter(baseline(), [adobe, dri]))).toEqual({ ok: true, width: 64, height: 48 });
  });

  it("an object shorter than the window (a small thumb)", () => {
    const small = baseline(8, 8);
    expect(small.length).toBeLessThan(1000);
    expect(walk(small).ok).toBe(true);
  });

  it("a scan that starts exactly at the end of the window", () => {
    const jpeg = baseline();
    const sos = segmentOffset(jpeg, 0xda);
    // Pad with an APP14 whose end puts the SOS header's last byte at HEADER_WINDOW − 1.
    const sosLength = 2 + ((jpeg[sos + 2]! << 8) | jpeg[sos + 3]!);
    const padding = HEADER_WINDOW - (sos + sosLength) - 4;
    const padded = insertAfter(jpeg, [segment(0xee, [...ascii("Adobe"), ...new Array<number>(padding - 5).fill(0)])]);
    expect(walk(padded).ok).toBe(true);
    // One more byte and the SOS ends past the window.
    const over = insertAfter(jpeg, [segment(0xee, [...ascii("Adobe"), ...new Array<number>(padding - 4).fill(0)])]);
    expect(rejected(over)).toBe("SOS past 64 KB");
  });
});

describe("checkJpegHeaders rejects", () => {
  it("APP1 with GPS EXIF", () => {
    expect(rejected(insertAfter(baseline(), [gpsExifSegment()]))).toBe("segment 0xe1 not allowed");
  });

  it("APP1 XMP", () => {
    expect(rejected(insertAfter(baseline(), [xmpSegment()]))).toBe("segment 0xe1 not allowed");
  });

  it("APP2 (ICC profile or MPF)", () => {
    const icc = segment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1, 0, 0, 0, 0]);
    expect(rejected(insertAfter(baseline(), [icc]))).toBe("segment 0xe2 not allowed");
  });

  it("APP13 (IPTC)", () => {
    const iptc = segment(0xed, [...ascii("Photoshop 3.0\0"), ...ascii("8BIM"), 4, 4, 0, 0, 0, 0, 0, 0]);
    expect(rejected(insertAfter(baseline(), [iptc]))).toBe("segment 0xed not allowed");
  });

  it("COM", () => {
    expect(rejected(insertAfter(baseline(), [segment(0xfe, ascii("serial 123"))]))).toBe("segment 0xfe not allowed");
  });

  it("any other APPn", () => {
    for (const marker of [0xe3, 0xe8, 0xef]) {
      expect(rejected(insertAfter(baseline(), [segment(marker, ascii("x"))]))).toBe(`segment 0x${marker.toString(16)} not allowed`);
    }
  });

  it("an APP0 that isn't JFIF (JFXX carries a thumbnail) and an APP14 that isn't Adobe", () => {
    expect(rejected(replacePayload(baseline(), 0xe0, [...ascii("JFXX\0"), 0x10, 0, 0]))).toBe("APP0 is not JFIF");
    expect(rejected(insertAfter(baseline(), [segment(0xee, ascii("Other"))]))).toBe("APP14 is not Adobe");
  });

  it("a progressive frame (SOF2) and every other non-baseline SOF", () => {
    expect(rejected(retag(baseline(), 0xc0, 0xc2))).toBe("segment 0xc2 not allowed");
    for (const sof of [0xc1, 0xc3, 0xc5, 0xc9, 0xca, 0xcb, 0xcd, 0xcf]) {
      expect(rejected(retag(baseline(), 0xc0, sof))).toBe(`segment 0x${sof.toString(16)} not allowed`);
    }
  });

  it("a second SOF0, a missing SOF, a 12-bit or zero-size frame", () => {
    const jpeg = baseline();
    const sofAt = segmentOffset(jpeg, 0xc0);
    const sof = jpeg.subarray(sofAt, sofAt + 2 + ((jpeg[sofAt + 2]! << 8) | jpeg[sofAt + 3]!));
    expect(rejected(insertBefore(jpeg, [sof], 0xc0))).toBe("more than one SOF");
    expect(rejected(remove(jpeg, 0xc0))).toBe("SOS before SOF");
    const twelveBit = sof.slice(4);
    twelveBit[0] = 12;
    expect(rejected(replacePayload(jpeg, 0xc0, twelveBit))).toBe("SOF not 8-bit");
    const zero = sof.slice(4);
    zero.set([0, 0], 3);
    expect(rejected(replacePayload(jpeg, 0xc0, zero))).toBe("SOF zero size");
    expect(rejected(replacePayload(jpeg, 0xc0, [8, 0, 48, 0]))).toBe("SOF too short");
  });

  it("trailing data that doesn't end in FFD9", () => {
    expect(rejected(concat(baseline(), ascii("trailer")))).toBe("no EOI");
  });

  it("a missing EOI", () => {
    const jpeg = baseline();
    expect(rejected(jpeg.subarray(0, jpeg.length - 2))).toBe("no EOI");
  });

  it("a PNG renamed .jpg, and an empty object", () => {
    expect(rejected(pngBytes())).toBe("no SOI");
    expect(rejected(new Uint8Array())).toBe("no SOI");
  });

  it("a file truncated before SOS", () => {
    const jpeg = baseline();
    const sos = segmentOffset(jpeg, 0xda);
    // Cut inside the DHT, then give the object a valid-looking EOI so only the walk can fail.
    expect(rejected(concat(jpeg.subarray(0, sos - 5), [0xff, 0xd9]))).toBe("truncated before SOS");
    expect(rejected(concat(jpeg.subarray(0, 3)))).toBe("truncated before SOS");
  });

  it("an SOS past 64 KB", () => {
    const padding = segment(0xee, [...ascii("Adobe"), ...new Array<number>(65_000).fill(0)]);
    expect(rejected(insertAfter(baseline(), [padding, padding]))).toBe("SOS past 64 KB");
  });

  it("garbage where a marker should be, and a segment length under 2", () => {
    const jpeg = baseline();
    const at = segmentOffset(jpeg, 0xdb);
    const garbage = jpeg.slice();
    garbage[at] = 0x00;
    expect(rejected(garbage)).toBe(`bad marker at ${at}`);
    const short = jpeg.slice();
    short.set([0x00, 0x01], at + 2);
    expect(rejected(short)).toBe(`bad segment length at ${at + 2}`);
  });

  it("fill bytes or a standalone marker before SOS (the booth encoder never writes them)", () => {
    expect(rejected(insertAfter(baseline(), [new Uint8Array([0xff, 0xff, 0x00, 0x02])]))).toBe("segment 0xff not allowed");
    expect(rejected(insertAfter(baseline(), [new Uint8Array([0xff, 0xd0, 0x00, 0x02])]))).toBe("segment 0xd0 not allowed");
  });

  it("only the last two bytes are checked: a tail that ends in FFD9 passes (accepted risk, DESIGN §13)", () => {
    expect(walk(concat(baseline(), ascii("smuggled"), [0xff, 0xd9])).ok).toBe(true);
  });
});
