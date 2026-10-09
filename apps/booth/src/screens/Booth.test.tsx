import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { resetPhotoPrefetcher, setPhotoPrefetcher } from "../ipc/photo";
import { resetBooth, useBooth } from "../store/store";
import { cameras, defaultSettings, flush, installBackend, removeBackend, until } from "../test/ipc";
import { uiConfig } from "../uiConfig";
import type { SessionState } from "../ipc/types";
import { Booth } from "./Booth";

const originalFill = uiConfig.fillMs;

/** Renders the booth and lets its startup promises (connect, probes) settle inside act(). */
async function mount() {
  const result = render(<Booth />);
  await act(async () => {
    await flush();
  });
  return result;
}

function seed(over: { camera?: string; preview?: "native" | "channel" } = {}) {
  const list = cameras();
  if (over.preview) {
    const cam = list.find((c) => c.id === (over.camera ?? "test"));
    if (cam) cam.preview = over.preview;
  }
  useBooth.setState({
    cameras: list,
    settings: defaultSettings({ selected_camera: over.camera ?? "test" }),
    screen: "booth",
  });
}

const setSession = (session: SessionState) =>
  act(() => {
    useBooth.getState().applySession(session);
  });

beforeEach(() => {
  resetBooth();
  uiConfig.fillMs = 10;
  seed();
});
afterEach(() => {
  uiConfig.fillMs = originalFill;
  removeBackend();
});

describe("camera lifecycle", () => {
  test("connects the camera and starts the live view on mount", async () => {
    const backend = installBackend();
    await mount();
    await until(() => backend.callsTo("live_view_start").length === 1, "live view started");
    expect(backend.calls.map((c) => c.cmd).filter((c) => c.startsWith("camera_") || c.startsWith("live_")))
      .toEqual(["camera_connect", "live_view_start"]);
  });

  test("stops the live view and disconnects the camera on unmount, in that order", async () => {
    const backend = installBackend();
    const { unmount } = await mount();
    await until(() => backend.callsTo("live_view_start").length === 1, "live view started");

    unmount();
    await until(() => backend.callsTo("camera_disconnect").length === 1, "camera disconnected");
    const cmds = backend.calls.map((c) => c.cmd);
    expect(cmds.indexOf("live_view_stop")).toBeLessThan(cmds.indexOf("camera_disconnect"));
  });

  test("a failing connect becomes a notice and no live view is started", async () => {
    const backend = installBackend({
      camera_connect: () => {
        throw "camera unavailable";
      },
    });
    await mount();
    await until(() => useBooth.getState().notice === "camera unavailable", "notice");
    expect(backend.callsTo("live_view_start")).toHaveLength(0);
  });

  test("keeps the screen awake while the booth is open", async () => {
    const backend = installBackend();
    const { unmount } = await mount();
    await until(
      () => backend.callsTo("plugin:photobooth-camera|window_set_keep_screen_on").length === 1,
      "keep awake on",
    );
    unmount();
    await until(
      () => backend.callsTo("plugin:photobooth-camera|window_set_keep_screen_on").length === 2,
      "keep awake off",
    );
    const flags = backend
      .callsTo("plugin:photobooth-camera|window_set_keep_screen_on")
      .map((c) => c.args.on);
    expect(flags).toEqual([true, false]);
  });
});

describe("session states", () => {
  test("attract is the starting view", async () => {
    installBackend();
    await mount();
    expect(screen.getByRole("button", { name: "Tap to start photoshoot" })).toBeTruthy();
    expect(screen.getByText("3 SHOTS")).toBeTruthy();
  });

  test("renders every state the backend can report", async () => {
    installBackend();
    await mount();

    await setSession({ state: "arming" });
    expect(screen.getByText(/GETTING THE CAMERA READY/)).toBeTruthy();

    await setSession({ state: "countdown", shot: 1, total: 3, remaining: 3 });
    expect(screen.getByText("Look at the lens")).toBeTruthy();

    await setSession({ state: "capturing", shot: 1, total: 3 });
    expect(screen.getByLabelText("Capturing")).toBeTruthy();

    await setSession({ state: "flash", shot: 1, total: 3, session_id: "s-1" });
    expect(screen.getByLabelText("Flash")).toBeTruthy();

    await setSession({
      state: "strip_review",
      session_id: "s-1",
      photos: [1, 2, 3],
      auto_return_in: 12,
    });
    expect(screen.getByText("Looking good.")).toBeTruthy();
    expect(screen.getAllByRole("img").map((i) => i.getAttribute("alt"))).toEqual([
      "Photo 1",
      "Photo 2",
      "Photo 3",
    ]);
    expect(screen.getByText("SARAH & TOM'S WEDDING")).toBeTruthy();

    await setSession({ state: "error", message: "capture failed", recoverable: true });
    expect(screen.getByRole("alert").textContent).toContain("capture failed");

    await setSession({ state: "attract" });
    expect(screen.getByRole("button", { name: "Tap to start photoshoot" })).toBeTruthy();
  });

  test("the booth's data-state attribute follows the session", async () => {
    installBackend();
    const { container } = await mount();
    await setSession({ state: "arming" });
    expect(container.querySelector("main")?.getAttribute("data-state")).toBe("arming");
  });
});

describe("photo prefetch", () => {
  const prefetched: string[] = [];
  const cleared: number[] = [];
  beforeEach(() => {
    prefetched.length = 0;
    cleared.length = 0;
    setPhotoPrefetcher({
      prefetch: (sessionId, shot) => {
        prefetched.push(`${sessionId}/${shot}`);
        return Promise.resolve();
      },
      urlFor: (sessionId, shot) => `${sessionId}/${shot}`,
      subscribe: () => () => undefined,
      clear: () => void cleared.push(cleared.length),
      size: 0,
    });
  });
  afterEach(() => resetPhotoPrefetcher());

  test("each photo is prefetched as soon as its shot is announced, so the strip finds it ready", async () => {
    installBackend();
    await mount();
    await setSession({ state: "countdown", shot: 1, total: 3, remaining: 1 });
    await setSession({ state: "capturing", shot: 1, total: 3 });
    expect(prefetched).toEqual([]);

    await setSession({ state: "flash", shot: 1, total: 3, session_id: "s-9" });
    expect(prefetched).toEqual(["s-9/1"]);

    await setSession({ state: "flash", shot: 2, total: 3, session_id: "s-9" });
    expect(prefetched).toEqual(["s-9/1", "s-9/2"]);
  });

  test("going back to attract releases the held photos; a session's own states do not", async () => {
    installBackend();
    await mount();
    const atStart = cleared.length; // an idempotent clear on the initial attract state is fine
    await setSession({ state: "flash", shot: 1, total: 1, session_id: "s-9" });
    await setSession({ state: "strip_review", session_id: "s-9", photos: [1], auto_return_in: 5 });
    expect(cleared).toHaveLength(atStart);

    await setSession({ state: "attract" });
    expect(cleared).toHaveLength(atStart + 1);
  });

  test("leaving the booth releases them too", async () => {
    installBackend();
    const { unmount } = await mount();
    await setSession({ state: "flash", shot: 1, total: 3, session_id: "s-9" });
    unmount();
    expect(cleared.length).toBeGreaterThanOrEqual(1);
  });
});

describe("guest actions", () => {
  test("tapping the start pill asks the backend to start once it fills", async () => {
    const backend = installBackend();
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Tap to start photoshoot" }));
    await until(() => backend.callsTo("session_start").length === 1, "session_start");
  });

  test("'Take another strip →' asks for a fresh strip", async () => {
    const backend = installBackend();
    await mount();
    await setSession({ state: "strip_review", session_id: "s", photos: [1], auto_return_in: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Take another strip →" }));
    await until(() => backend.callsTo("session_take_another").length === 1, "take another");
  });

  test("an error offers Try again (start) and Back to start (return home)", async () => {
    const backend = installBackend();
    await mount();
    await setSession({ state: "error", message: "boom", recoverable: true });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await until(() => backend.callsTo("session_start").length === 1, "retry");
    fireEvent.click(screen.getByRole("button", { name: "Back to start" }));
    await until(() => backend.callsTo("session_return_home").length === 1, "home");
  });

  test("a rejected command is surfaced rather than swallowed", async () => {
    installBackend({
      session_start: () => {
        throw "finish the current session first";
      },
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Tap to start photoshoot" }));
    await until(
      () => useBooth.getState().notice === "finish the current session first",
      "notice",
    );
  });

  test("Back leaves the booth for the camera picker", async () => {
    installBackend();
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(useBooth.getState().screen).toBe("select");
  });

  test("Back is not offered mid-session", async () => {
    installBackend();
    await mount();
    await setSession({ state: "countdown", shot: 1, total: 3, remaining: 2 });
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});

describe("connection problems", () => {
  test("shows the camera's error with a Retry connection button that reconnects", async () => {
    const backend = installBackend();
    await mount();
    await until(() => backend.callsTo("live_view_start").length === 1, "first start");

    act(() => {
      useBooth.getState().applyCameraStatus({
        camera: "test",
        status: { state: "error", message: "camera not in PC Remote mode?" },
      });
    });
    expect(screen.getByRole("status").textContent).toContain("camera not in PC Remote mode?");

    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await until(() => backend.callsTo("camera_connect").length === 2, "second connect");
    await until(() => backend.callsTo("live_view_start").length === 2, "second live view");
    expect(backend.callsTo("live_view_stop").length).toBeGreaterThanOrEqual(1);
  });

  test("a disconnected camera says so; a connecting one has no retry button", async () => {
    installBackend();
    await mount();
    act(() => {
      useBooth.getState().applyCameraStatus({ camera: "test", status: { state: "disconnected" } });
    });
    expect(screen.getByText("Camera disconnected")).toBeTruthy();

    act(() => {
      useBooth.getState().applyCameraStatus({ camera: "test", status: { state: "connecting" } });
    });
    expect(screen.getByText("Connecting to camera…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry connection" })).toBeNull();
  });

  test("the start pill is disabled while the banner is up, and usable again once the camera is ready", async () => {
    const backend = installBackend();
    await mount();
    const pill = () => screen.getByRole("button", { name: "Tap to start photoshoot" }) as HTMLButtonElement;
    expect(pill().disabled).toBe(false);

    for (const status of [
      { state: "error", message: "camera not in PC Remote mode?" },
      { state: "disconnected" },
      { state: "connecting" },
    ] as const) {
      act(() => {
        useBooth.getState().applyCameraStatus({ camera: "test", status });
      });
      expect(pill().disabled).toBe(true);
      fireEvent.click(pill());
    }
    await act(async () => {
      await flush();
    });
    expect(backend.callsTo("session_start")).toHaveLength(0);

    act(() => {
      useBooth.getState().applyCameraStatus({ camera: "test", status: { state: "ready" } });
    });
    expect(pill().disabled).toBe(false);
    fireEvent.click(pill());
    await until(() => backend.callsTo("session_start").length === 1, "session_start");
  });

  test("a healthy camera shows no banner", async () => {
    installBackend();
    await mount();
    act(() => {
      useBooth.getState().applyCameraStatus({ camera: "test", status: { state: "ready" } });
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("preview", () => {
  test("a native-preview camera leaves the booth transparent for the CameraX layer", async () => {
    seed({ camera: "test", preview: "native" });
    installBackend();
    const { container } = await mount();
    expect(container.querySelector("main")?.className).toContain("booth--native");
  });

  test("a streamed camera paints onto a canvas", async () => {
    installBackend();
    const { container } = await mount();
    expect(container.querySelector("main")?.className).toContain("booth--channel");
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  test("the preview is mirrored per the setting", async () => {
    installBackend();
    const { container, unmount } = await mount();
    expect(container.querySelector(".booth__preview")?.className).toContain("is-mirrored");
    unmount();

    useBooth.setState({ settings: defaultSettings({ mirror_preview: false }) });
    const second = await mount();
    expect(second.container.querySelector(".booth__preview")?.className).not.toContain(
      "is-mirrored",
    );
  });

  test("the strip review uses the configured headline, date and display time", async () => {
    useBooth.setState({
      settings: defaultSettings({ headline: "Ada & Bo", event_date: "01.02.2027", strip_display_seconds: 20 }),
    });
    installBackend();
    await mount();
    await setSession({ state: "strip_review", session_id: "s", photos: [1], auto_return_in: 10 });
    expect(screen.getByText("ADA & BO")).toBeTruthy();
    expect(screen.getByText("01.02.2027")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("20");
  });
});
