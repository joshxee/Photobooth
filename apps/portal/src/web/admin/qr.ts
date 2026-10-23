// The event QR (DESIGN §12): the whole-event gallery link, drawn in the browser. The matrix comes
// from `qrcode-generator` (MIT, ~50 KB unminified, no dependencies); everything drawn from it
// (the SVG for print, the raster for PNG) is ours, so what a printer gets is the matrix and nothing
// else. Error correction Q: printed signage gets scuffed, and the link is short enough for it.
import qrcode from "qrcode-generator";

/** The quiet zone the spec asks for, in modules. */
const QUIET = 4;

export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "Q");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => qr.isDark(y, x)));
}

/** A self-contained SVG: white square, one black path of horizontal runs, crisp edges. */
export function qrSvg(text: string): string {
  const matrix = qrMatrix(text);
  const size = matrix.length + 2 * QUIET;
  let path = "";
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      path += `M${x + QUIET},${y + QUIET}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}

/** RGBA pixels, `scale` px per module: what the PNG download draws and the tests decode. */
export function qrRgba(text: string, scale: number): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const matrix = qrMatrix(text);
  const modules = matrix.length + 2 * QUIET;
  const width = modules * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) {
    const row = matrix[Math.floor(y / scale) - QUIET];
    if (!row) continue;
    for (let x = 0; x < width; x++) {
      if (row[Math.floor(x / scale) - QUIET]) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  return { data, width, height: width };
}

/** A PNG of the code, about 1000 px square, for messaging. Needs a canvas (browsers only). */
export function qrPng(text: string): Promise<Blob> {
  const modules = qrMatrix(text).length + 2 * QUIET;
  const { data, width, height } = qrRgba(text, Math.max(1, Math.ceil(1000 / modules)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("canvas unavailable"));
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png"));
}

/** `smith-wedding-gallery-qr.svg`. Anything outside ASCII letters and digits becomes a hyphen. */
export function qrFilename(eventName: string, ext: "svg" | "png"): string {
  const slug = eventName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "event"}-gallery-qr.${ext}`;
}
