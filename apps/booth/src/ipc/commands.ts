// One typed wrapper per backend command. The names must match src-tauri/build.rs and the
// capability files; a command missing from a capability is rejected by Tauri at runtime.

import { invoke, type Channel } from "@tauri-apps/api/core";

import type {
  CameraId,
  CameraInfo,
  Fault,
  FrameRegion,
  OutboxEntry,
  OutboxStatus,
  PortalEvent,
  PortalStatus,
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

export const portalStatus = () => invoke<PortalStatus>("portal_status");
export const portalEnrol = (enrolment: { url: string; code: string; name: string }) =>
  invoke<PortalStatus>("portal_enrol", enrolment);
export const portalUnenrol = () => invoke<PortalStatus>("portal_unenrol");
export const portalEvents = () => invoke<PortalEvent[]>("portal_events");
/** Rust re-fetches the event and refuses it unless it is OPEN. */
export const portalSelectEvent = (id: string) => invoke<PortalStatus>("portal_select_event", { id });
export const portalClearEvent = () => invoke<PortalStatus>("portal_clear_event");

export const outboxStatus = () => invoke<OutboxStatus>("outbox_status");
/** The needs-attention list. */
export const outboxItems = () => invoke<OutboxEntry[]>("outbox_items");
export const outboxRetry = (id: string) => invoke<void>("outbox_retry", { id });
/** Deletes the booth's copy (the SD card keeps the original); the UI confirms first. */
export const outboxDismiss = (id: string) => invoke<void>("outbox_dismiss", { id });

/** Dev capability only: rejected in a release build. */
export const testInject = (fault: Fault) => invoke<void>("test_inject", { fault });
/** Dev capability only: rejected in a release build. */
export const logsRecent = (limit?: number) => invoke<string[]>("logs_recent", { limit });
