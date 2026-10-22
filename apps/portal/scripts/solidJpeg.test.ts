import { describe, expect, it } from "bun:test";
import { solidJpeg } from "./solidJpeg";

/** Marker bytes of each segment before the scan, plus SOF0's size. */
function walk(jpeg: Uint8Array): { markers: number[]; width: number; height: number } {
  const markers: number[] = [];
  let width = 0;
  let height = 0;
  let i = 2;
  for (;;) {
    expect(jpeg[i]).toBe(0xff);
    const marker = jpeg[i + 1]!;
    markers.push(marker);
    const length = (jpeg[i + 2]! << 8) | jpeg[i + 3]!;
    if (marker === 0xc0) {
      height = (jpeg[i + 5]! << 8) | jpeg[i + 6]!;
      width = (jpeg[i + 7]! << 8) | jpeg[i + 8]!;
    }
    if (marker === 0xda) return { markers, width, height };
    i += 2 + length;
  }
}

describe("solidJpeg", () => {
  it("is SOI, APP0 JFIF, DQT, SOF0, DHT, SOS … EOI and nothing else (what the header walk allows)", () => {
    const jpeg = solidJpeg(2560, 1707, [200, 60, 90]);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect([jpeg.at(-2), jpeg.at(-1)]).toEqual([0xff, 0xd9]);
    expect(Array.from(jpeg.subarray(6, 11))).toEqual([0x4a, 0x46, 0x49, 0x46, 0x00]); // "JFIF\0"
    expect(walk(jpeg)).toEqual({ markers: [0xe0, 0xdb, 0xc0, 0xc4, 0xda], width: 2560, height: 1707 });
  });

  it("encodes sizes that aren't multiples of 8, and is deterministic", () => {
    const jpeg = solidJpeg(13, 7, [1, 2, 3]);
    expect(walk(jpeg)).toMatchObject({ width: 13, height: 7 });
    expect(solidJpeg(13, 7, [1, 2, 3])).toEqual(jpeg);
  });

  it("stays small (seed objects are well under the intent caps)", () => {
    expect(solidJpeg(2560, 1707, [0, 0, 0]).byteLength).toBeLessThan(3_000_000);
    expect(solidJpeg(480, 320, [255, 255, 255]).byteLength).toBeLessThan(200_000);
  });

  it("refuses impossible sizes", () => {
    expect(() => solidJpeg(0, 10, [0, 0, 0])).toThrow();
    expect(() => solidJpeg(10, 65536, [0, 0, 0])).toThrow();
  });
});
