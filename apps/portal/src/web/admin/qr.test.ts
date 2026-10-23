import { describe, expect, it } from "bun:test";
import jsQR from "jsqr";
import { qrFilename, qrMatrix, qrRgba, qrSvg } from "./qr";

const URL_WITH_TOKEN = "https://photos.example.invalid/e/abcdefghijklmnop#k=Xk3p0Qm_9vTzLwB2nR7sYdE4aHcJfUgN5iOe1KtV8Z";

function decode(rgba: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  return jsQR(rgba.data, rgba.width, rgba.height)?.data ?? null;
}

/** Reads the matrix back out of the SVG's path, so the file a printer gets is what is decoded. */
function matrixFromSvg(svg: string): { size: number; dark: boolean[][] } {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
  const size = Number(viewBox[1]);
  const dark = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const m of svg.matchAll(/M(\d+),(\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, len] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < len; i++) dark[y]![x + i] = true;
  }
  return { size, dark };
}

describe("QR code", () => {
  it("decodes to the whole event link, token fragment included", () => {
    expect(decode(qrRgba(URL_WITH_TOKEN, 6))).toBe(URL_WITH_TOKEN);
  });

  it("decodes for a range of link lengths (the QR version grows with the link)", () => {
    for (const n of [1, 40, 120, 300]) {
      const text = `https://photos.example.invalid/e/abcdefghijklmnop#k=${"a1B2".repeat(Math.ceil(n / 4)).slice(0, n)}`;
      expect(decode(qrRgba(text, 5))).toBe(text);
    }
  });

  it("different links give different codes", () => {
    const a = qrMatrix(URL_WITH_TOKEN).map((r) => r.join("")).join("");
    const b = qrMatrix(URL_WITH_TOKEN.replace("#k=X", "#k=Y")).map((r) => r.join("")).join("");
    expect(a).not.toBe(b);
  });

  it("draws the SVG from the same matrix, with a 4-module quiet zone and no external references", () => {
    const svg = qrSvg(URL_WITH_TOKEN);
    const matrix = qrMatrix(URL_WITH_TOKEN);
    const { size, dark } = matrixFromSvg(svg);
    expect(size).toBe(matrix.length + 8);
    for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) expect(dark[y + 4]![x + 4]).toBe(matrix[y]![x]!);
    for (let i = 0; i < size; i++) {
      for (let q = 0; q < 4; q++) expect(dark[q]![i] || dark[size - 1 - q]![i] || dark[i]![q] || dark[i]![size - 1 - q]).toBe(false);
    }
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(svg).not.toContain("<script");
  });

  it("the SVG file decodes too (rasterised from its own path)", () => {
    const { size, dark } = matrixFromSvg(qrSvg(URL_WITH_TOKEN));
    const scale = 6;
    const width = size * scale;
    const data = new Uint8ClampedArray(width * width * 4).fill(255);
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++)
        if (dark[Math.floor(y / scale)]![Math.floor(x / scale)]) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    expect(decode({ data, width, height: width })).toBe(URL_WITH_TOKEN);
  });

  it("the raster is black modules on opaque white with the same quiet zone", () => {
    const { data, width, height } = qrRgba(URL_WITH_TOKEN, 3);
    const modules = qrMatrix(URL_WITH_TOKEN).length;
    expect(width).toBe((modules + 8) * 3);
    expect(height).toBe(width);
    expect([...data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255);
  });

  it("names downloads after the event, safe for a file system", () => {
    expect(qrFilename("Smith & Jones: 50th/Party!", "svg")).toBe("smith-jones-50th-party-gallery-qr.svg");
    expect(qrFilename("", "png")).toBe("event-gallery-qr.png");
    expect(qrFilename("✨ 🎉", "png")).toBe("event-gallery-qr.png");
  });
});
