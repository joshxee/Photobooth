import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { resetBooth, useBooth } from "../store/store";
import { flush, installBackend, removeBackend, until } from "../test/ipc";
import { DevPanel } from "./DevPanel";

beforeEach(resetBooth);
afterEach(removeBackend);

async function mount() {
  const result = render(<DevPanel />);
  await act(async () => {
    await flush();
  });
  return result;
}

describe("DevPanel", () => {
  test("is absent when the backend refuses the dev capability (a release build)", async () => {
    installBackend({
      logs_recent: () => {
        throw "command logs_recent not allowed by capability";
      },
    });
    const { container } = await mount();
    expect(container.innerHTML).toBe("");
  });

  test("is a small toggle when the dev capability is available", async () => {
    installBackend({ logs_recent: () => [] });
    await mount();
    expect(screen.getByRole("button", { name: "Dev" })).toBeTruthy();
    expect(screen.queryByLabelText("Developer panel")).toBeNull();
  });

  test("opens, offers every fault, and sends the right one", async () => {
    const backend = installBackend({ logs_recent: () => [] });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));
    const panel = screen.getByLabelText("Developer panel");

    const expected: [string, unknown][] = [
      ["Start session", { kind: "start_session" }],
      ["Skip countdown", { kind: "skip_countdown" }],
      ["Fail next capture", { kind: "fail_next_capture" }],
      ["Disconnect camera", { kind: "disconnect_camera" }],
      ["Slow next capture (5 s)", { kind: "slow_next_capture", ms: 5000 }],
      ["Reset settings", { kind: "reset_settings" }],
    ];
    for (const [label] of expected) {
      fireEvent.click(within(panel).getByRole("button", { name: label }));
    }
    await until(() => backend.callsTo("test_inject").length === expected.length, "all injected");
    expect(backend.callsTo("test_inject").map((c) => c.args.fault)).toEqual(
      expected.map(([, fault]) => fault),
    );
  });

  test("closes again", async () => {
    installBackend({ logs_recent: () => [] });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Dev" })).toBeTruthy();
  });

  test("tails the session and camera events, newest first", async () => {
    installBackend({ logs_recent: () => [] });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));
    act(() => {
      useBooth.getState().applySession({ state: "arming" });
      useBooth.getState().applyCameraStatus({ camera: "test", status: { state: "busy" } });
    });
    const items = within(screen.getByLabelText("Event log"))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual(["camera test: busy", "session arming"]);
  });

  test("a rejected injection is surfaced as a notice", async () => {
    installBackend({
      logs_recent: () => [],
      test_inject: () => {
        throw "nope";
      },
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip countdown" }));
    await until(() => useBooth.getState().notice === "nope", "notice");
  });
});
