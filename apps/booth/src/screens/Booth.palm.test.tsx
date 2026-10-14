import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";

import { resetBooth, useBooth } from "../store/store";
import { cameras, defaultSettings, flush, installBackend, removeBackend, until } from "../test/ipc";
import { Booth } from "./Booth";

async function mount() {
  const result = render(<Booth />);
  await act(async () => {
    await flush();
  });
  return result;
}

function seed(over: { trigger?: "tap" | "gesture"; preview?: "native" | "channel" } = {}) {
  const list = cameras();
  const test = list.find((c) => c.id === "test");
  if (test && over.preview) test.preview = over.preview;
  useBooth.setState({
    cameras: list,
    settings: defaultSettings({ start_trigger: over.trigger ?? "gesture" }),
    screen: "booth",
  });
}

/** happy-dom has no layout, so give the canvas and the box the geometry of a 2880x1800 tablet. */
function lay(container: HTMLElement) {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  canvas.width = 600;
  canvas.height = 400;
  canvas.dataset.framed = "true";
  canvas.getBoundingClientRect = () => rect(0, 0, 2880, 1800);
  const box = container.querySelector(".palmbox") as HTMLElement;
  box.getBoundingClientRect = () => rect(1900, 300, 960, 1200);
}

beforeEach(resetBooth);
afterEach(removeBackend);

describe("open-palm start in the booth", () => {
  test("the palm box replaces the tap-only prompt when gestures are on", async () => {
    installBackend();
    seed();
    await mount();
    expect(screen.getByRole("heading").textContent).toBe(
      "Put your palm in the box to start the photobooth",
    );
    expect(screen.getByRole("button", { name: "Tap here to start" })).toBeTruthy();
  });

  test("tap-only when gestures are off", async () => {
    installBackend();
    seed({ trigger: "tap" });
    const { container } = await mount();
    expect(container.querySelector(".palmbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Tap to start photoshoot" })).toBeTruthy();
  });

  test("tap-only for a camera that streams no frames to look at", async () => {
    installBackend();
    seed({ preview: "native" });
    const { container } = await mount();
    expect(container.querySelector(".palmbox")).toBeNull();
  });

  test("tells Rust where the box is in the camera frame, mirror and cover fit included", async () => {
    const backend = installBackend();
    seed();
    const { container } = await mount();
    lay(container);

    await until(() => backend.callsTo("gesture_set_region").length > 0, "region reported", 1500);
    const sent = backend.callsTo("gesture_set_region").at(-1)?.args as {
      x: number;
      y: number;
      w: number;
      h: number;
    };
    // The 1.5:1 frame is stretched to cover the 1.6:1 screen, so a little is cropped top and
    // bottom; the preview is mirrored, so the box on the right of the screen is on the frame's left.
    expect(sent.x).toBeCloseTo(0.0069, 3);
    expect(sent.y).toBeCloseTo(0.1875, 3);
    expect(sent.w).toBeCloseTo(0.3333, 3);
    expect(sent.h).toBeCloseTo(0.625, 3);
  });

  test("outlines the palm Rust found on the preview", async () => {
    installBackend();
    seed();
    const { container } = await mount();
    lay(container);
    expect(container.querySelector(".palm-highlight")).toBeNull();

    act(() => {
      useBooth.getState().applyGesture({
        palm: { x: 0.1, y: 0.2, w: 0.2, h: 0.3 },
        holding: true,
        hold_ms: 1000,
      });
    });
    const el = container.querySelector(".palm-highlight") as HTMLElement;
    expect(el).toBeTruthy();
    // Mirrored: frame x 0.1..0.3 is screen x 0.7..0.9, so its centre is 80% across.
    expect(parseFloat(el.style.left)).toBeCloseTo(80, 0);
    expect(container.querySelector(".palmbox")?.classList.contains("is-holding")).toBe(true);
  });
});
