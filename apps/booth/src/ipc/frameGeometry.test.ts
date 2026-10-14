import { describe, expect, test } from "bun:test";

import { differs, frameToScreen, screenToFrame, type Rect } from "./frameGeometry";

const close = (a: Rect, b: Rect) => {
  for (const k of ["x", "y", "w", "h"] as const) expect(a[k]).toBeCloseTo(b[k], 5);
};

describe("screenToFrame", () => {
  test("a frame with the screen's own shape maps one to one", () => {
    close(screenToFrame({ x: 0.5, y: 0.2, w: 0.3, h: 0.6 }, 1.6, 1.6, false), {
      x: 0.5,
      y: 0.2,
      w: 0.3,
      h: 0.6,
    });
  });

  test("a wider frame is cropped left and right by the cover fit", () => {
    // 3:1 frame on a 1.5:1 screen: the screen shows the middle half of the frame's width.
    const frame = screenToFrame({ x: 0, y: 0, w: 1, h: 1 }, 3, 1.5, false);
    close(frame, { x: 0.25, y: 0, w: 0.5, h: 1 });
  });

  test("a taller frame is cropped top and bottom", () => {
    const frame = screenToFrame({ x: 0, y: 0, w: 1, h: 1 }, 1, 2, false);
    close(frame, { x: 0, y: 0.25, w: 1, h: 0.5 });
  });

  test("mirroring flips the box across the frame", () => {
    // The right of the screen is the left of the frame when the preview is mirrored.
    const frame = screenToFrame({ x: 0.6, y: 0.1, w: 0.3, h: 0.5 }, 1.5, 1.5, true);
    close(frame, { x: 0.1, y: 0.1, w: 0.3, h: 0.5 });
  });

  test("a box hanging off the screen is clamped to the frame", () => {
    const frame = screenToFrame({ x: 0.8, y: 0.8, w: 0.5, h: 0.5 }, 1.5, 1.5, false);
    close(frame, { x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
  });
});

describe("frameToScreen", () => {
  test("is the inverse of screenToFrame", () => {
    for (const [frameAspect, viewAspect, mirrored] of [
      [1.5, 1.6, true],
      [1.5, 1.6, false],
      [1.78, 0.75, true],
      [1, 2, false],
    ] as const) {
      const box = { x: 0.55, y: 0.25, w: 0.3, h: 0.5 };
      const there = screenToFrame(box, frameAspect, viewAspect, mirrored);
      close(frameToScreen(there, frameAspect, viewAspect, mirrored), box);
    }
  });

  test("a palm in the cropped-off part of the frame is clamped to the screen edge", () => {
    const onScreen = frameToScreen({ x: 0, y: 0.4, w: 0.1, h: 0.2 }, 3, 1.5, false);
    expect(onScreen.w).toBe(0);
  });
});

describe("differs", () => {
  test("ignores sub-pixel jitter and reports real movement", () => {
    const a = { x: 0.5, y: 0.2, w: 0.3, h: 0.6 };
    expect(differs(null, a)).toBe(true);
    expect(differs(a, { ...a, x: 0.502 })).toBe(false);
    expect(differs(a, { ...a, w: 0.31 })).toBe(true);
  });
});
