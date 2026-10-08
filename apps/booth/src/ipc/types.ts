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
}

export type SettingsPatch = Partial<Omit<Settings, "test_mode">> & {
  test_mode?: Partial<TestModeSettings>;
};

export type Fault =
  | { kind: "fail_next_capture" }
  | { kind: "disconnect_camera" }
  | { kind: "slow_next_capture"; ms: number }
  | { kind: "skip_countdown" }
  | { kind: "start_session" }
  | { kind: "reset_settings" };

export const TEST_PATTERNS = ["bars", "checker", "gradient"] as const;
