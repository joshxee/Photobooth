// Mirrors the DTOs in src-tauri (photobooth-core and src-tauri/src/dto.rs). These are plain
// data: all behaviour lives in Rust, the WebView only renders what it is told.

export type CameraId = "device" | "sony_usb" | "test" | (string & {});

export type CameraStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "ready" }
  | { state: "busy" }
  | { state: "error"; message: string };

export type PreviewKind = "channel" | "native";

export interface CameraInfo {
  id: CameraId;
  name: string;
  available: boolean;
  reason: string | null;
  preview: PreviewKind;
  status: CameraStatus;
  selected: boolean;
}

export interface CameraStatusEvent {
  camera: CameraId;
  status: CameraStatus;
}

export type SessionState =
  | { state: "attract" }
  | { state: "arming" }
  | { state: "countdown"; shot: number; total: number; remaining: number }
  | { state: "capturing"; shot: number; total: number }
  | { state: "flash"; shot: number; total: number; session_id: string }
  | { state: "strip_review"; session_id: string; photos: number[]; auto_return_in: number }
  | { state: "error"; message: string; recoverable: boolean };

export interface TestModeSettings {
  capture_delay_ms: number;
  fail_every_n: number;
  pattern: string;
}

export interface Settings {
  selected_camera: CameraId;
  number_of_photos: number;
  countdown_seconds: number;
  strip_display_seconds: number;
  headline: string;
  event_date: string;
  mirror_preview: boolean;
  start_trigger: "tap" | "gesture";
  test_mode: TestModeSettings;
  /** Changed only by enrolment (portal_enrol). */
  portal_url: string;
  /** Changed only by event selection (portal_select_event, portal_clear_event). */
  selected_event: SelectedEvent | null;
}

export type SettingsPatch = Partial<
  Omit<Settings, "test_mode" | "portal_url" | "selected_event">
> & {
  test_mode?: Partial<TestModeSettings>;
};

/** The portal event new photos go to. */
export interface SelectedEvent {
  id: string;
  name: string;
  /** `YYYY-MM-DD`, in the event's time zone. */
  local_date: string;
}

/** What the operator UI knows about the portal. Never the device credential. */
export interface PortalStatus {
  enrolled: boolean;
  /** The enrolled portal, or the address the enrolment form starts with. */
  portal_url: string;
  portal_host: string | null;
  device_name: string | null;
  selected_event: SelectedEvent | null;
  /** Why the stored enrolment can't be used. */
  problem: string | null;
}

/** The upload queue, for the operator (`outbox_status`, `portal://outbox`). Counts only. */
export interface OutboxStatus {
  /** The outbox opened; false means this booth can't queue photos. */
  available: boolean;
  queued: number;
  uploading: number;
  /** Everything in the needs-attention list. */
  needs_attention: number;
  /** The last upload attempt got no answer from the portal. */
  offline: boolean;
  /** The portal refused this booth's credential; uploads wait for a new enrolment. */
  revoked: boolean;
  free_bytes: number | null;
  /** Below 1 GB free. */
  low_disk: boolean;
}

/** `upload`: retry or delete; `damaged`: files without a record; `not_queued`: never queued. */
export type OutboxEntryKind = "upload" | "damaged" | "not_queued";

/** One row of the needs-attention list (`outbox_items`). Never image bytes. */
export interface OutboxEntry {
  id: string;
  kind: OutboxEntryKind;
  reason: string;
  session_id: string | null;
  shot: number | null;
  captured_at: string | null;
  event_id: string | null;
  can_retry: boolean;
}

/** An event that accepts uploads now. */
export interface PortalEvent extends SelectedEvent {
  venue: string;
  timezone: string;
}

/** A rectangle in the camera frame, as fractions of its width and height (unmirrored). */
export interface FrameRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Payload of `gesture://state`: what to draw for the open-palm start. */
export interface GestureUpdate {
  /** The palm found in the box (highlight it on the preview), if any. */
  palm: FrameRegion | null;
  /** A palm has been held in the box and the ring should be filling. */
  holding: boolean;
  /** How long the ring takes to fill. */
  hold_ms: number;
}

export type Fault =
  | { kind: "fail_next_capture" }
  | { kind: "disconnect_camera" }
  | { kind: "slow_next_capture"; ms: number }
  | { kind: "skip_countdown" }
  | { kind: "start_session" }
  | { kind: "reset_settings" }
  | { kind: "hold_palm"; on: boolean };

export const TEST_PATTERNS = ["bars", "checker", "gradient"] as const;
