import { describe, expect, it } from "vitest";
import { downloadFilename, variantKey } from "./media";

describe("variantKey", () => {
  it("is events/{eventId}/{photoId}/{variant}.jpg", () => {
    expect(variantKey("e", "p", "hd")).toBe("events/e/p/hd.jpg");
  });
});

describe("downloadFilename", () => {
  it("is <event-slug>-<session>-<shot>.jpg", () => {
    expect(downloadFilename("Smith wedding", "6a3f1c20-3", 2)).toBe("smith-wedding-6a3f1c20-3-2.jpg");
  });

  it("is ASCII only: accents folded, everything else collapsed to single dashes", () => {
    expect(downloadFilename("Zoë & Mātene's   Wedding!!", "s-1", 0)).toBe("zoe-matene-s-wedding-s-1-0.jpg");
    expect(downloadFilename('a"b\\c/d\r\ne;f', "s", 1)).toBe("a-b-c-d-e-f-s-1.jpg");
    expect(downloadFilename("--Gala--", "s", 1)).toBe("gala-s-1.jpg");
  });

  it("falls back to 'photo' when nothing ASCII is left", () => {
    expect(downloadFilename("婚礼", "s", 1)).toBe("photo-s-1.jpg");
    expect(downloadFilename("🎉🎉", "s", 1)).toBe("photo-s-1.jpg");
  });

  it("caps the slug at 40 characters without a trailing dash", () => {
    const name = downloadFilename(`${"a".repeat(39)} bbbb`, "s", 1);
    expect(name).toBe(`${"a".repeat(39)}-s-1.jpg`);
    expect(downloadFilename("x".repeat(100), "s", 1)).toBe(`${"x".repeat(40)}-s-1.jpg`);
  });

  it("only ever contains safe filename characters", () => {
    for (const name of ["Ünïcødé", "<script>", "../../etc/passwd", "a\u0000b", "CON"]) {
      expect(downloadFilename(name, "AbC_1-2", 999)).toMatch(/^[a-z0-9-]+-AbC_1-2-999\.jpg$/);
    }
  });
});
