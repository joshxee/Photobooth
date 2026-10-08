import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { App } from "./App";
import { resetBooth, useBooth } from "./store/store";
import { cameras, defaultSettings, flush, installBackend, removeBackend, until } from "./test/ipc";
import { uiConfig } from "./uiConfig";

const originalFill = uiConfig.fillMs;

beforeEach(() => {
  resetBooth();
  uiConfig.fillMs = 10;
});
afterEach(() => {
  uiConfig.fillMs = originalFill;
  removeBackend();
});

const fullBackend = () =>
  installBackend({
    session_state: () => ({ state: "attract" }),
    camera_list: () => cameras(),
    settings_get: () => defaultSettings({ selected_camera: "test" }),
    logs_recent: () => [],
    register_listener: () => undefined,
  });

async function mount() {
  const result = render(<App />);
  await act(async () => {
    await flush();
  });
  return result;
}

describe("App", () => {
  test("starts on the camera picker and loads the backend snapshots", async () => {
    const backend = fullBackend();
    await mount();
    expect(screen.getByRole("heading", { name: "Select Camera" })).toBeTruthy();
    await until(() => useBooth.getState().cameras.length === 3, "cameras loaded");
    expect(backend.callsTo("session_state")).toHaveLength(1);
    expect(backend.callsTo("settings_get")).toHaveLength(1);
  });

  test("goes immersive on startup", async () => {
    const backend = fullBackend();
    await mount();
    await until(
      () => backend.callsTo("plugin:photobooth-camera|window_set_immersive").length === 1,
      "immersive requested",
    );
  });

  test("walks picker → booth → a complete session driven by backend events", async () => {
    const backend = fullBackend();
    await mount();
    await until(() => useBooth.getState().settings !== null, "settings loaded");

    fireEvent.click(await screen.findByRole("button", { name: "Continue →" }));
    expect(await screen.findByRole("button", { name: "Tap to start photoshoot" })).toBeTruthy();
    await until(() => backend.callsTo("live_view_start").length === 1, "live view");

    fireEvent.click(screen.getByRole("button", { name: "Tap to start photoshoot" }));
    await until(() => backend.callsTo("session_start").length === 1, "start sent");

    const run = async (state: object) => {
      await act(async () => {
        await backend.emit("session://state", state);
        await flush();
      });
    };
    await run({ state: "arming" });
    await run({ state: "countdown", shot: 1, total: 3, remaining: 3 });
    expect(screen.getByText("Look at the lens")).toBeTruthy();
    await run({ state: "flash", shot: 1, total: 3 });
    await run({
      state: "strip_review",
      session_id: "s-1",
      photos: [1, 2, 3],
      auto_return_in: 12,
    });
    expect(screen.getByText("Take another strip →")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(3);
    await run({ state: "attract" });
    expect(screen.getByRole("button", { name: "Tap to start photoshoot" })).toBeTruthy();
  });

  test("a camera status event reaches the booth's connection banner", async () => {
    const backend = fullBackend();
    await mount();
    await until(() => useBooth.getState().settings !== null, "settings loaded");
    fireEvent.click(await screen.findByRole("button", { name: "Continue →" }));
    await screen.findByRole("button", { name: "Tap to start photoshoot" });

    await act(async () => {
      await backend.emit("camera://status", {
        camera: "test",
        status: { state: "error", message: "USB cable unplugged" },
      });
      await flush();
    });
    expect(screen.getByRole("status").textContent).toContain("USB cable unplugged");
  });

  test("the hardware back button leaves the booth and settings, but does nothing on the picker", async () => {
    const backend = fullBackend();
    await mount();
    await until(
      () => backend.callsTo("plugin:photobooth-camera|register_listener").length === 1,
      "back listener registered",
    );
    const registration = backend.channels["plugin:photobooth-camera|register_listener"]?.[0];
    expect(registration).toBeDefined();
    const pressBack = () => act(async () => registration?.onmessage({}));

    await pressBack();
    expect(useBooth.getState().screen).toBe("select");

    act(() => useBooth.getState().setScreen("booth"));
    await pressBack();
    expect(useBooth.getState().screen).toBe("select");

    act(() => useBooth.getState().setScreen("settings"));
    await pressBack();
    expect(useBooth.getState().screen).toBe("select");
  });

  test("a notice is shown, can be dismissed, and expires on its own", async () => {
    fullBackend();
    await mount();
    act(() => useBooth.getState().setNotice("camera unavailable"));
    expect(screen.getByRole("alert").textContent).toContain("camera unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("settings opens from the picker and returns", async () => {
    fullBackend();
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Select Camera" })).toBeTruthy();
  });
});
