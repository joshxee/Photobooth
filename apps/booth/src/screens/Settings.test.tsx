import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";

import type { Settings as SettingsType } from "../ipc/types";
import { resetBooth, useBooth } from "../store/store";
import { defaultSettings, flush, installBackend, removeBackend, until } from "../test/ipc";
import { Settings } from "./Settings";

beforeEach(() => {
  resetBooth();
  useBooth.setState({ settings: defaultSettings(), screen: "settings" });
});
afterEach(removeBackend);

/** A backend whose settings_set applies the patch the way the real one would. */
function backendThatApplies() {
  let current = defaultSettings();
  return installBackend({
    settings_set: (args) => {
      const patch = args.patch as Partial<SettingsType> & { test_mode?: object };
      const { test_mode, ...rest } = patch;
      current = {
        ...current,
        ...rest,
        test_mode: { ...current.test_mode, ...(test_mode ?? {}) },
      };
      return current;
    },
  });
}

const slider = (name: string) => screen.getByRole("slider", { name }) as HTMLInputElement;

describe("Settings", () => {
  test("shows every setting and a summary of the current configuration", () => {
    installBackend();
    render(<Settings />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(slider("Number of Photos").value).toBe("3");
    expect(slider("Countdown Seconds").value).toBe("3");
    expect(slider("Photo Strip Display Time").value).toBe("12");
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe(
      "Sarah & Tom's Wedding",
    );
    expect((screen.getByLabelText("Event Date") as HTMLInputElement).value).toBe("06.05.2026");
    expect((screen.getByLabelText("Mirror Preview") as HTMLInputElement).checked).toBe(true);

    expect(screen.getByText("• 3 photos per session")).toBeTruthy();
    expect(screen.getByText("• 3 second countdown")).toBeTruthy();
    expect(screen.getByText("• Photo strip displays for 12 seconds")).toBeTruthy();
  });

  test("moving a slider sends just that field and shows the validated result", async () => {
    const backend = backendThatApplies();
    render(<Settings />);
    fireEvent.change(slider("Number of Photos"), { target: { value: "5" } });
    await until(() => backend.callsTo("settings_set").length === 1, "settings_set");
    expect(backend.callsTo("settings_set")[0]?.args).toEqual({ patch: { number_of_photos: 5 } });
    await until(() => useBooth.getState().settings?.number_of_photos === 5, "store updated");
    expect(screen.getByText("• 5 photos per session")).toBeTruthy();
  });

  test("each slider maps to its own field", async () => {
    const backend = backendThatApplies();
    render(<Settings />);
    fireEvent.change(slider("Countdown Seconds"), { target: { value: "7" } });
    fireEvent.change(slider("Photo Strip Display Time"), { target: { value: "20" } });
    await until(() => backend.callsTo("settings_set").length === 2, "both sent");
    expect(backend.callsTo("settings_set").map((c) => c.args.patch)).toEqual([
      { countdown_seconds: 7 },
      { strip_display_seconds: 20 },
    ]);
  });

  test("text fields commit on blur, not on every keystroke", async () => {
    const backend = backendThatApplies();
    render(<Settings />);
    const headline = screen.getByLabelText("Headline");
    fireEvent.change(headline, { target: { value: "Ada" } });
    fireEvent.change(headline, { target: { value: "Ada & Bo" } });
    await flush();
    expect(backend.callsTo("settings_set")).toHaveLength(0);

    fireEvent.blur(headline);
    await until(() => backend.callsTo("settings_set").length === 1, "committed");
    expect(backend.callsTo("settings_set")[0]?.args).toEqual({ patch: { headline: "Ada & Bo" } });
  });

  test("Enter also commits, and an unchanged value sends nothing", async () => {
    const backend = backendThatApplies();
    render(<Settings />);
    const date = screen.getByLabelText("Event Date");
    fireEvent.change(date, { target: { value: "01.02.2027" } });
    fireEvent.keyDown(date, { key: "Enter" });
    await until(() => backend.callsTo("settings_set").length === 1, "committed");

    const headline = screen.getByLabelText("Headline");
    fireEvent.focus(headline);
    fireEvent.blur(headline);
    await flush();
    expect(backend.callsTo("settings_set")).toHaveLength(1);
  });

  test("the mirror toggle is a checkbox", async () => {
    const backend = backendThatApplies();
    render(<Settings />);
    fireEvent.click(screen.getByLabelText("Mirror Preview"));
    await until(() => backend.callsTo("settings_set").length === 1, "toggle sent");
    expect(backend.callsTo("settings_set")[0]?.args).toEqual({ patch: { mirror_preview: false } });
  });

  test("a value the backend rejects becomes a notice", async () => {
    installBackend({
      settings_set: () => {
        throw "countdown_seconds must be between 1 and 10 (got 11)";
      },
    });
    render(<Settings />);
    fireEvent.change(slider("Countdown Seconds"), { target: { value: "9" } });
    await until(() => useBooth.getState().notice !== null, "notice");
    expect(useBooth.getState().notice).toContain("countdown_seconds");
    expect(useBooth.getState().settings?.countdown_seconds).toBe(3);
  });

  test("test-camera options appear only when the test camera is selected", async () => {
    const backend = backendThatApplies();
    act(() => {
      useBooth.setState({ settings: defaultSettings({ selected_camera: "device" }) });
    });
    const { rerender } = render(<Settings />);
    expect(screen.queryByText("Test Camera")).toBeNull();

    act(() => {
      useBooth.setState({ settings: defaultSettings({ selected_camera: "test" }) });
    });
    rerender(<Settings />);
    expect(screen.getByText("Test Camera")).toBeTruthy();

    fireEvent.change(slider("Capture Delay (ms)"), { target: { value: "1200" } });
    fireEvent.change(screen.getByLabelText("Test Pattern"), { target: { value: "checker" } });
    await until(() => backend.callsTo("settings_set").length === 2, "test settings sent");
    expect(backend.callsTo("settings_set").map((c) => c.args.patch)).toEqual([
      { test_mode: { capture_delay_ms: 1200 } },
      { test_mode: { pattern: "checker" } },
    ]);
  });

  test("Back returns to the camera picker", () => {
    installBackend();
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(useBooth.getState().screen).toBe("select");
  });

  test("shows a loading note until settings arrive", () => {
    useBooth.setState({ settings: null });
    installBackend();
    render(<Settings />);
    expect(screen.getByRole("status").textContent).toBe("Loading settings…");
  });
});
