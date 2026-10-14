// Maps rectangles between the screen and the camera frame.
//
// The preview canvas fills the screen with `object-fit: cover` (the frame is scaled until it
// covers the screen, and the overflow is cropped evenly on both sides) and may be mirrored. The
// palm box is drawn on the screen, but the detector looks at the frame, and the highlight on a
// found palm goes the other way. Everything here is in fractions (0 to 1) of the screen or of
// the *unmirrored* frame, so only the two aspect ratios matter, never pixels.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The part of the frame the screen shows: fractions of the frame's width and height. */
function visible(frameAspect: number, viewAspect: number): Rect {
  if (frameAspect > viewAspect) {
    const w = viewAspect / frameAspect;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = frameAspect / viewAspect;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function clampRect({ x, y, w, h }: Rect): Rect {
  const x0 = clamp01(x);
  const y0 = clamp01(y);
  return { x: x0, y: y0, w: clamp01(x + w) - x0, h: clamp01(y + h) - y0 };
}

/** A rectangle on the screen, as the part of the frame it covers. */
export function screenToFrame(
  rect: Rect,
  frameAspect: number,
  viewAspect: number,
  mirrored: boolean,
): Rect {
  const seen = visible(frameAspect, viewAspect);
  const x = mirrored ? 1 - rect.x - rect.w : rect.x;
  return clampRect({
    x: seen.x + x * seen.w,
    y: seen.y + rect.y * seen.h,
    w: rect.w * seen.w,
    h: rect.h * seen.h,
  });
}

/** A rectangle in the frame, as where it appears on the screen. */
export function frameToScreen(
  rect: Rect,
  frameAspect: number,
  viewAspect: number,
  mirrored: boolean,
): Rect {
  const seen = visible(frameAspect, viewAspect);
  const x = (rect.x - seen.x) / seen.w;
  const w = rect.w / seen.w;
  return clampRect({
    x: mirrored ? 1 - x - w : x,
    y: (rect.y - seen.y) / seen.h,
    w,
    h: rect.h / seen.h,
  });
}

/** Whether two rectangles differ by more than `epsilon` in any side (to skip pointless updates). */
export function differs(a: Rect | null, b: Rect, epsilon = 0.005): boolean {
  return (
    !a ||
    Math.abs(a.x - b.x) > epsilon ||
    Math.abs(a.y - b.y) > epsilon ||
    Math.abs(a.w - b.w) > epsilon ||
    Math.abs(a.h - b.h) > epsilon
  );
}
