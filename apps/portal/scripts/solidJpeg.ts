// A solid-colour baseline JPEG of any size, for seed data (no image library needed).
// Segments: SOI, APP0 JFIF, DQT, SOF0, DHT, SOS, scan, EOI: only what the upload header walk
// (DESIGN §9.1) allows, and no metadata. Every 8×8 block is flat, so each block is its DC value
// followed by an end-of-block code; after the first MCU every DC difference is 0, and the scan
// is a run of zero bits.

// Standard luminance DC table (ITU T.81 Annex K.3), used for all three components.
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
// An AC table with one symbol, EOB (0x00), coded as the single bit "0".
const AC_BITS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const AC_VALUES = [0];

/** Canonical Huffman codes (T.81 Annex C) for a table: symbol → [code, length]. */
function huffmanCodes(bits: number[], values: number[]): Map<number, [number, number]> {
  const codes = new Map<number, [number, number]>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < bits[length - 1]!; i++) codes.set(values[k++]!, [code++, length]);
    code <<= 1;
  }
  return codes;
}

class BitWriter {
  private bytes: number[] = [];
  private current = 0;
  private count = 0;

  write(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.current = (this.current << 1) | ((value >> i) & 1);
      if (++this.count === 8) this.flushByte();
    }
  }

  /** Pads the last byte with 1-bits, as T.81 requires. */
  finish(): number[] {
    if (this.count > 0) this.write(0xff, 8 - this.count);
    return this.bytes;
  }

  private flushByte(): void {
    this.bytes.push(this.current);
    if (this.current === 0xff) this.bytes.push(0x00); // byte stuffing
    this.current = 0;
    this.count = 0;
  }
}

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

function u16(n: number): number[] {
  return [n >> 8, n & 0xff];
}

export function solidJpeg(width: number, height: number, [r, g, b]: [number, number, number]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new Error(`bad size ${width}×${height}`);
  }
  // YCbCr (JFIF), level-shifted. With a quantiser of 1, a flat block's DC coefficient is 8 × value.
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const dcs = [y, cb, cr].map((v) => 8 * (Math.round(Math.min(255, Math.max(0, v))) - 128));

  const dc = huffmanCodes(DC_BITS, DC_VALUES);
  const eob = huffmanCodes(AC_BITS, AC_VALUES).get(0)!;
  const scan = new BitWriter();
  const mcus = Math.ceil(width / 8) * Math.ceil(height / 8);
  for (let m = 0; m < mcus; m++) {
    for (const value of dcs) {
      const diff = m === 0 ? value : 0;
      const magnitude = Math.abs(diff);
      const category = magnitude === 0 ? 0 : Math.floor(Math.log2(magnitude)) + 1;
      const [code, length] = dc.get(category)!;
      scan.write(code, length);
      if (category > 0) scan.write(diff >= 0 ? diff : diff + (1 << category) - 1, category);
      scan.write(eob[0], eob[1]);
    }
  }

  const bytes = [
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, ...u16(1), ...u16(1), 0, 0]),
    ...segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
    ...segment(0xc0, [8, ...u16(height), ...u16(width), 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ...segment(0xc4, [0x00, ...DC_BITS, ...DC_VALUES, 0x10, ...AC_BITS, ...AC_VALUES]),
    ...segment(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]),
    ...scan.finish(),
    0xff, 0xd9,
  ];
  return new Uint8Array(bytes);
}
