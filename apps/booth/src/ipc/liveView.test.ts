import { afterEach, describe, expect, test } from "bun:test";

import { flush, installBackend, removeBackend, until } from "../test/ipc";
import { createFramePainter, startLiveView } from "./liveView";

afterEach(removeBackend);

const frame = (n: number) => new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9]).buffer;

function fakeCanvas() {
  const drawn: number[] = [];
  const canvas = {
    width: 0,
    height: 0,
    dataset: {} as DOMStringMap,
    getContext: () => ({ drawImage: () => drawn.push(drawn.length) }),
  } as unknown as HTMLCanvasElement;
  return { canvas, drawn };
}

/** A decoder whose results the test releases by hand, to hold a decode "in flight". */
function manualDecoder() {
  const pending: { blob: Blob; resolve: () => void }[] = [];
  const decode = (blob: Blob) =>
    new Promise<ImageBitmap>((resolve) =>
      pending.push({
        blob,
        resolve: () => resolve({ width: 4, height: 3, close() {} } as unknown as ImageBitmap),
      }),
    );
  return { decode, pending };
}

describe("frame painter", () => {
  test("draws frames and sizes the canvas to the image", async () => {
    const { canvas, drawn } = fakeCanvas();
    const painter = createFramePainter(
      canvas,
      async () => ({ width: 320, height: 180 }) as ImageBitmap,
    );
    painter.push(frame(1));
    await flush();
    expect(drawn).toHaveLength(1);
    expect([canvas.width, canvas.height]).toEqual([320, 180]);
    expect(painter.drawn).toBe(1);
  });

  test("keeps only the newest frame while a decode is in flight", async () => {
    const { canvas } = fakeCanvas();
    const { decode, pending } = manualDecoder();
    const painter = createFramePainter(canvas, decode);

    painter.push(frame(1)); // starts decoding
    painter.push(frame(2)); // parked
    painter.push(frame(3)); // replaces 2 — dropped
    painter.push(frame(4)); // replaces 3 — dropped
    expect(pending).toHaveLength(1);
    expect(painter.dropped).toBe(2);

    pending[0]?.resolve();
    await flush();
    expect(pending).toHaveLength(2); // the newest parked frame is decoded next
    const bytes = new Uint8Array(await pending[1]!.blob.arrayBuffer());
    expect(bytes[2]).toBe(4);

    pending[1]?.resolve();
    await flush();
    expect(painter.drawn).toBe(2);
    expect(pending).toHaveLength(2);
  });

  test("a corrupt frame is skipped and the next one still paints", async () => {
    const { canvas } = fakeCanvas();
    let calls = 0;
    const painter = createFramePainter(canvas, async () => {
      calls += 1;
      if (calls === 1) throw new Error("bad jpeg");
      return { width: 2, height: 2 } as ImageBitmap;
    });
    painter.push(frame(1));
    await flush();
    painter.push(frame(2));
    await flush();
    expect(painter.drawn).toBe(1);
  });

  test("nothing is drawn after close, including a decode that finishes late", async () => {
    const { canvas } = fakeCanvas();
    const { decode, pending } = manualDecoder();
    const painter = createFramePainter(canvas, decode);
    painter.push(frame(1));
    painter.close();
    pending[0]?.resolve();
    await flush();
    painter.push(frame(2));
    await flush();
    expect(painter.drawn).toBe(0);
    expect(pending).toHaveLength(1);
  });
});

describe("startLiveView", () => {
  test("opens the channel, paints what the backend sends, and stops on request", async () => {
    const backend = installBackend();
    const { canvas } = fakeCanvas();
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () =>
      ({ width: 8, height: 6, close() {} }) as ImageBitmap;

    const stop = await startLiveView(canvas);
    const channel = backend.channels["live_view_start"]?.[0];
    expect(channel).toBeDefined();

    channel?.onmessage(frame(1));
    await until(() => canvas.width === 8, "first frame painted");

    await stop();
    expect(backend.callsTo("live_view_stop")).toHaveLength(1);
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  });

  test("a failed start is reported and leaves nothing running", async () => {
    installBackend({
      live_view_start: () => {
        throw "no camera is selected";
      },
    });
    const { canvas } = fakeCanvas();
    await expect(startLiveView(canvas)).rejects.toBe("no camera is selected");
  });
});
