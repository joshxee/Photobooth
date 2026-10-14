import { useEffect, type RefObject } from "react";

import { gestureSetRegion } from "../ipc";
import { differs, screenToFrame, type Rect } from "../ipc/frameGeometry";

/** The shapes of the camera frame and of the screen it fills; null before the first frame. */
export function previewAspects(
  canvas: HTMLCanvasElement | null,
): { frame: number; view: number } | null {
  if (!canvas || canvas.dataset.framed !== "true") return null;
  const view = canvas.getBoundingClientRect();
  if (!view.width || !view.height || !canvas.width || !canvas.height) return null;
  return { frame: canvas.width / canvas.height, view: view.width / view.height };
}

/**
 * While `active`, keeps Rust told where the palm box sits in the *camera frame* (it only sees
 * the frame, not the screen). Re-reports when the layout changes; the box is measured every
 * half second because the first frame, and so the frame's shape, can arrive after mount.
 */
export function usePalmRegion(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  boxRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  mirrored: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    let last: Rect | null = null;

    const report = () => {
      const canvas = canvasRef.current;
      const box = boxRef.current;
      const aspects = previewAspects(canvas);
      if (!canvas || !box || !aspects) return;
      const view = canvas.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const onScreen: Rect = {
        x: (b.left - view.left) / view.width,
        y: (b.top - view.top) / view.height,
        w: b.width / view.width,
        h: b.height / view.height,
      };
      const region = screenToFrame(onScreen, aspects.frame, aspects.view, mirrored);
      if (region.w <= 0 || region.h <= 0 || !differs(last, region)) return;
      last = region;
      gestureSetRegion(region).catch(() => {
        last = null; // try again on the next tick
      });
    };

    report();
    const timer = setInterval(report, 500);
    window.addEventListener("resize", report);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", report);
    };
  }, [canvasRef, boxRef, active, mirrored]);
}
