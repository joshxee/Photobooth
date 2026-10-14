// One typed wrapper per backend command. The names must match src-tauri/build.rs and the
// capability files; a command missing from a capability is rejected by Tauri at runtime.

import { invoke, type Channel } from "@tauri-apps/api/core";

import type {
  CameraId,
  CameraInfo,
  Fault,
  FrameRegion,
  SessionState,
  Settings,
  SettingsPatch,
} from "./types";

export const cameraList = () => invoke<CameraInfo[]>("camera_list");
export const cameraSelect = (id: CameraId) => invoke<void>("camera_select", { id });
export const cameraConnect = () => invoke<void>("camera_connect");
export const cameraDisconnect = () => invoke<void>("camera_disconnect");

/** `channel` receives raw JPEG bytes (an ArrayBuffer per message), never base64. */
export const liveViewStart = (channel: Channel<ArrayBuffer>) =>
  invoke<void>("live_view_start", { channel });
export const liveViewStop = () => invoke<void>("live_view_stop");

/** Tells Rust where the palm box sits in the camera frame, so it knows where to look. */
export const gestureSetRegion = (region: FrameRegion) => invoke<void>("gesture_set_region", { x: region.x, y: region.y, w: region.w, h: region.h });

export const sessionStart = () => invoke<void>("session_start");
export const sessionCancel = () => invoke<void>("session_cancel");
export const sessionTakeAnother = () => invoke<void>("session_take_another");
export const sessionReturnHome = () => invoke<void>("session_return_home");
export const sessionState = () => invoke<SessionState>("session_state");

export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSet = (patch: SettingsPatch) => invoke<Settings>("settings_set", { patch });

/** Dev capability only: rejected in a release build. */
export const testInject = (fault: Fault) => invoke<void>("test_inject", { fault });
/** Dev capability only: rejected in a release build. */
export const logsRecent = (limit?: number) => invoke<string[]>("logs_recent", { limit });
