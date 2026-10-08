// Paints raw JPEG frames from a Tauri Channel onto a <canvas>.
//
// Keep-latest semantics: decoding is asynchronous, and frames can arrive faster than they
// decode. If a decode is in flight the newest frame is parked (replacing any older parked
// one) and decoded next; stale frames are dropped rather than queued, so the preview never
// lags further and further behind the camera.

import { Channel } from "@tauri-apps/api/core";

import { liveViewStart, liveViewStop } from "./commands";

type Decode = (blob: Blob) => Promise<ImageBitmap>;

export interface FramePainter {
  /** Offer a frame; returns immediately. */
  push(data: ArrayBuffer): void;
  /** Stop painting (in-flight decodes are discarded). */
  close(): void;
  /** Frames drawn so far (for tests and diagnostics). */
  readonly drawn: number;
  /** Frames dropped because a newer one superseded them. */
  readonly dropped: number;
}

export function createFramePainter(
  canvas: HTMLCanvasElement,
  decode: Decode = (blob) => createImageBitmap(blob),
): FramePainter {
  let decoding = false;
  let parked: ArrayBuffer | null = null;
  let closed = false;
  let drawn = 0;
  let dropped = 0;

  const run = async (data: ArrayBuffer) => {
    decoding = true;
    try {
      const bitmap = await decode(new Blob([data], { type: "image/jpeg" }));
      if (!closed) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        drawn += 1;
      }
      bitmap.close?.();
    } catch {
      // A corrupt frame is skipped; the next one repaints.
    } finally {
      decoding = false;
      const next = parked;
      parked = null;
      if (next && !closed) void run(next);
    }
  };

  return {
    push(data) {
      if (closed) return;
      if (decoding) {
        if (parked) dropped += 1;
        parked = data;
      } else {
        void run(data);
      }
    },
    close() {
      closed = true;
      parked = null;
    },
    get drawn() {
      return drawn;
    },
    get dropped() {
      return dropped;
    },
  };
}

/**
 * Opens the backend's live-view channel and paints it on `canvas`. Resolves once the stream is
 * running; the returned function stops it. Backends with a native preview send no frames, so
 * the canvas simply stays empty.
 */
export async function startLiveView(canvas: HTMLCanvasElement): Promise<() => Promise<void>> {
  const painter = createFramePainter(canvas);
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (data) => painter.push(data);
  try {
    await liveViewStart(channel);
  } catch (error) {
    painter.close();
    throw error;
  }
  return async () => {
    painter.close();
    await liveViewStop().catch(() => undefined);
  };
}
