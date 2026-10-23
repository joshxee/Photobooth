import { afterEach, describe, expect, test } from "bun:test";
import { Channel } from "@tauri-apps/api/core";

import { installBackend, removeBackend } from "../test/ipc";
import * as ipc from "./index";

afterEach(removeBackend);

describe("command wrappers", () => {
  test("each wrapper invokes the matching backend command with the right arguments", async () => {
    const backend = installBackend();
    const channel = new Channel<ArrayBuffer>();

    await ipc.cameraList();
    await ipc.cameraSelect("test");
    await ipc.cameraConnect();
    await ipc.cameraDisconnect();
    await ipc.liveViewStart(channel);
    await ipc.liveViewStop();
    await ipc.sessionStart();
    await ipc.sessionCancel();
    await ipc.sessionTakeAnother();
    await ipc.sessionReturnHome();
    await ipc.sessionState();
    await ipc.settingsGet();
    await ipc.settingsSet({ number_of_photos: 5, test_mode: { pattern: "checker" } });
    await ipc.portalStatus();
    await ipc.portalEnrol({ url: "https://photos.example.invalid", code: "7K3M9Q2Z", name: "Booth 1" });
    await ipc.portalUnenrol();
    await ipc.portalEvents();
    await ipc.portalSelectEvent("019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01");
    await ipc.portalClearEvent();
    await ipc.testInject({ kind: "slow_next_capture", ms: 2000 });
    await ipc.logsRecent(50);

    expect(backend.calls.map((c) => c.cmd)).toEqual([
      "camera_list",
      "camera_select",
      "camera_connect",
      "camera_disconnect",
      "live_view_start",
      "live_view_stop",
      "session_start",
      "session_cancel",
      "session_take_another",
      "session_return_home",
      "session_state",
      "settings_get",
      "settings_set",
      "portal_status",
      "portal_enrol",
      "portal_unenrol",
      "portal_events",
      "portal_select_event",
      "portal_clear_event",
      "test_inject",
      "logs_recent",
    ]);
    expect(backend.callsTo("portal_enrol")[0]?.args).toEqual({
      url: "https://photos.example.invalid",
      code: "7K3M9Q2Z",
      name: "Booth 1",
    });
    expect(backend.callsTo("portal_select_event")[0]?.args).toEqual({
      id: "019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01",
    });
    expect(backend.callsTo("camera_select")[0]?.args).toEqual({ id: "test" });
    expect(backend.callsTo("live_view_start")[0]?.args.channel).toBe(channel);
    expect(backend.callsTo("settings_set")[0]?.args).toEqual({
      patch: { number_of_photos: 5, test_mode: { pattern: "checker" } },
    });
    expect(backend.callsTo("test_inject")[0]?.args).toEqual({
      fault: { kind: "slow_next_capture", ms: 2000 },
    });
    expect(backend.callsTo("logs_recent")[0]?.args).toEqual({ limit: 50 });
  });

  test("results and rejections pass through unchanged", async () => {
    installBackend({
      session_state: () => ({ state: "arming" }),
      camera_select: () => {
        throw "camera unavailable";
      },
    });
    expect(await ipc.sessionState()).toEqual({ state: "arming" });
    await expect(ipc.cameraSelect("device")).rejects.toBe("camera unavailable");
  });
});
