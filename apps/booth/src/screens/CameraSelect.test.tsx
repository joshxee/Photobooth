import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { resetBooth, useBooth } from "../store/store";
import { cameras, defaultSettings, flush, installBackend, removeBackend, until } from "../test/ipc";
import { CameraSelect } from "./CameraSelect";

beforeEach(() => {
  resetBooth();
  useBooth.setState({
    cameras: cameras(),
    settings: defaultSettings({ selected_camera: "device" }),
  });
});
afterEach(removeBackend);

async function mount() {
  const result = render(<CameraSelect />);
  await act(async () => {
    await flush();
  });
  return result;
}

describe("CameraSelect", () => {
  test("lists the three cameras with their descriptions", async () => {
    installBackend({ camera_list: () => cameras() });
    await mount();

    expect(screen.getByRole("heading", { name: "Select Camera" })).toBeTruthy();
    expect(screen.getByText("Test Camera")).toBeTruthy();
    expect(screen.getByText("Test mode • Fast capture • No hardware required")).toBeTruthy();
    expect(screen.getByText("Sony A7 III (USB)")).toBeTruthy();
    expect(screen.getByText("Device Camera")).toBeTruthy();
  });

  test("an unavailable camera shows why instead of its description", async () => {
    installBackend({ camera_list: () => cameras() });
    await mount();
    const device = screen.getByText("Device Camera").closest("button") as HTMLElement;
    expect(within(device).getByText("Only available on the Android tablet")).toBeTruthy();
    expect(device.getAttribute("aria-disabled")).toBe("true");
  });

  test("an available camera can be selected; the choice goes to the backend", async () => {
    const backend = installBackend({ camera_list: () => cameras() });
    await mount();

    fireEvent.click(screen.getByText("Test Camera").closest("button") as HTMLElement);
    await until(() => backend.callsTo("camera_select").length === 1, "camera_select");
    expect(backend.callsTo("camera_select")[0]?.args).toEqual({ id: "test" });
    await until(
      () => useBooth.getState().settings?.selected_camera === "test",
      "selection reflected",
    );
    expect(screen.getByRole("img", { name: "Selected" })).toBeTruthy();
  });

  test("tapping an unavailable camera does nothing", async () => {
    const backend = installBackend({ camera_list: () => cameras() });
    await mount();
    fireEvent.click(screen.getByText("Sony A7 III (USB)").closest("button") as HTMLElement);
    await flush();
    expect(backend.callsTo("camera_select")).toHaveLength(0);
  });

  test("a backend refusal is shown as a notice and the selection is unchanged", async () => {
    installBackend({
      camera_list: () => cameras(),
      camera_select: () => {
        throw "finish or cancel the current session before changing camera";
      },
    });
    await mount();
    fireEvent.click(screen.getByText("Test Camera").closest("button") as HTMLElement);
    await until(() => useBooth.getState().notice !== null, "notice");
    expect(useBooth.getState().notice).toContain("current session");
    expect(useBooth.getState().settings?.selected_camera).toBe("device");
  });

  test("Continue → is disabled until an available camera is selected", async () => {
    installBackend({ camera_list: () => cameras() });
    await mount();
    const next = screen.getByRole("button", { name: "Continue →" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true); // device is selected but unavailable

    act(() => {
      useBooth.getState().setSettings(defaultSettings({ selected_camera: "test" }));
    });
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(useBooth.getState().screen).toBe("booth");
  });

  test("the gear opens Settings", async () => {
    installBackend({ camera_list: () => cameras() });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useBooth.getState().screen).toBe("settings");
  });

  test("availability is re-checked while the screen is open", async () => {
    const backend = installBackend({ camera_list: () => cameras() });
    await mount();
    expect(backend.callsTo("camera_list").length).toBeGreaterThanOrEqual(1);

    backend.on("camera_list", () =>
      cameras({ sony_usb: { available: true, reason: null, status: { state: "disconnected" } } }),
    );
    await until(
      () => useBooth.getState().cameras.find((c) => c.id === "sony_usb")?.available === true,
      "sony shows up",
      4000,
    );
    expect(screen.getByText("Wired USB • PC Remote mode • Full-resolution JPEG")).toBeTruthy();
  });
});
