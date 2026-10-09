import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cameras, defaultSettings, flush, installBackend, removeBackend, until } from "../test/ipc";
import { errorMessage, refreshCameras, startBridge } from "./bridge";
import {
  resetBooth,
  selectedCamera,
  selectedCameraId,
  selectedCameraStatus,
  useBooth,
} from "./store";

beforeEach(resetBooth);
afterEach(removeBackend);

describe("store", () => {
  test("starts on the camera picker with an idle session", () => {
    const s = useBooth.getState();
    expect(s.screen).toBe("select");
    expect(s.session).toEqual({ state: "attract" });
    expect(s.settings).toBeNull();
  });

  test("session and camera events are applied and logged", () => {
    const s = useBooth.getState();
    s.applySession({ state: "countdown", shot: 2, total: 3, remaining: 1 });
    s.applyCameraStatus({ camera: "test", status: { state: "error", message: "boom" } });

    const after = useBooth.getState();
    expect(after.session.state).toBe("countdown");
    expect(after.cameraStatus["test"]).toEqual({ state: "error", message: "boom" });
    expect(after.eventLog.map((e) => e.text)).toEqual([
      "countdown 1 (shot 2/3)",
      "test: error: boom",
    ]);
  });

  test("the event log keeps only the most recent entries", () => {
    for (let i = 0; i < 100; i += 1) {
      useBooth.getState().applySession({ state: "countdown", shot: 1, total: 1, remaining: i });
    }
    const log = useBooth.getState().eventLog;
    expect(log).toHaveLength(60);
    expect(log.at(-1)?.text).toContain("countdown 99");
  });

  test("seeding statuses from the camera list never clobbers a newer event", () => {
    const s = useBooth.getState();
    s.applyCameraStatus({ camera: "test", status: { state: "busy" } });
    s.setCameras(cameras());
    expect(useBooth.getState().cameraStatus["test"]).toEqual({ state: "busy" });
    expect(useBooth.getState().cameraStatus["device"]).toEqual({ state: "disconnected" });
  });

  test("selectors resolve the selected camera from settings", () => {
    const s = useBooth.getState();
    s.setCameras(cameras());
    s.setSettings(defaultSettings({ selected_camera: "sony_usb" }));
    s.applyCameraStatus({ camera: "sony_usb", status: { state: "ready" } });

    expect(selectedCameraId(useBooth.getState())).toBe("sony_usb");
    expect(selectedCamera(useBooth.getState())?.name).toBe("Sony A7 III (USB)");
    expect(selectedCameraStatus(useBooth.getState())).toEqual({ state: "ready" });
  });

  test("describes every session state in the event log", () => {
    const s = useBooth.getState();
    s.applySession({ state: "attract" });
    s.applySession({ state: "arming" });
    s.applySession({ state: "capturing", shot: 1, total: 3 });
    s.applySession({ state: "flash", shot: 1, total: 3, session_id: "x" });
    s.applySession({ state: "strip_review", session_id: "x", photos: [1, 2], auto_return_in: 9 });
    s.applySession({ state: "error", message: "bad", recoverable: false });
    expect(useBooth.getState().eventLog.map((e) => e.text)).toEqual([
      "attract",
      "arming",
      "capturing (shot 1/3)",
      "flash (shot 1/3)",
      "strip_review (2 photos, returns in 9s)",
      "error: bad (not recoverable)",
    ]);
  });
});

describe("bridge", () => {
  const backend = () =>
    installBackend({
      session_state: () => ({ state: "attract" }),
      camera_list: () => cameras(),
      settings_get: () => defaultSettings(),
    });

  test("loads the initial snapshots", async () => {
    backend();
    const detach = await startBridge();
    const s = useBooth.getState();
    expect(s.cameras).toHaveLength(3);
    expect(s.settings?.selected_camera).toBe("test");
    expect(s.session.state).toBe("attract");
    detach();
  });

  test("forwards backend events into the store", async () => {
    const fake = backend();
    const detach = await startBridge();

    await fake.emit("session://state", { state: "arming" });
    await fake.emit("camera://status", { camera: "test", status: { state: "busy" } });
    await until(() => useBooth.getState().session.state === "arming", "session event");
    await until(() => useBooth.getState().cameraStatus["test"]?.state === "busy", "camera event");
    detach();
  });

  test("forwards the open-palm updates", async () => {
    const fake = backend();
    const detach = await startBridge();
    expect(useBooth.getState().gesture).toBeNull();

    const update = { palm: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, holding: true, hold_ms: 1000 };
    await fake.emit("gesture://state", update);
    await until(() => useBooth.getState().gesture?.holding === true, "gesture event");
    expect(useBooth.getState().gesture).toEqual(update);
    detach();
  });

  test("a stale snapshot never overwrites a newer session event", async () => {
    const fake = backend();
    fake.on("session_state", async () => {
      // The snapshot is slow; an event arrives while it is in flight.
      await fake.emit("session://state", {
        state: "strip_review",
        session_id: "s",
        photos: [1],
        auto_return_in: 5,
      });
      await flush();
      return { state: "attract" };
    });
    const detach = await startBridge();
    expect(useBooth.getState().session.state).toBe("strip_review");
    detach();
  });

  test("detaching stops event delivery", async () => {
    const fake = backend();
    const detach = await startBridge();
    detach();
    await flush();
    await fake.emit("session://state", { state: "arming" });
    await flush();
    expect(useBooth.getState().session.state).toBe("attract");
  });

  test("a failing snapshot becomes a notice instead of throwing", async () => {
    installBackend({
      session_state: () => {
        throw "backend not ready";
      },
      camera_list: () => cameras(),
      settings_get: () => defaultSettings(),
    });
    const detach = await startBridge();
    expect(useBooth.getState().notice).toBe("backend not ready");
    detach();
  });

  test("refreshCameras updates the list and reports failures", async () => {
    const fake = installBackend({ camera_list: () => cameras() });
    await refreshCameras();
    expect(useBooth.getState().cameras).toHaveLength(3);

    fake.on("camera_list", () => {
      throw new Error("offline");
    });
    await refreshCameras();
    expect(useBooth.getState().notice).toBe("offline");
  });

  test("errorMessage handles strings, errors and anything else", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(new Error("wrapped"))).toBe("wrapped");
    expect(errorMessage(42)).toBe("42");
  });
});
