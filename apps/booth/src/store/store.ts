// UI state fed purely by IPC. There is deliberately no business logic here: the session state
// machine, camera orchestration and settings validation all live in Rust.

import { create } from "zustand";

import type {
  CameraId,
  CameraInfo,
  CameraStatus,
  CameraStatusEvent,
  GestureUpdate,
  SessionState,
  Settings,
} from "../ipc/types";

export type Screen = "select" | "booth" | "settings";

export interface LogEntry {
  id: number;
  at: number;
  kind: "session" | "camera";
  text: string;
}

const MAX_LOG_ENTRIES = 60;

interface BoothState {
  screen: Screen;
  session: SessionState;
  cameras: CameraInfo[];
  cameraStatus: Record<string, CameraStatus>;
  settings: Settings | null;
  /** The latest open-palm update; null until the first one arrives. */
  gesture: GestureUpdate | null;
  eventLog: LogEntry[];
  /** Last user-facing problem (a rejected command); cleared by the UI. */
  notice: string | null;

  setScreen(screen: Screen): void;
  applySession(session: SessionState): void;
  applyCameraStatus(event: CameraStatusEvent): void;
  applyGesture(update: GestureUpdate): void;
  setCameras(cameras: CameraInfo[]): void;
  setSettings(settings: Settings): void;
  setNotice(notice: string | null): void;
}

let nextLogId = 1;

function describeSession(s: SessionState): string {
  switch (s.state) {
    case "countdown":
      return `countdown ${s.remaining} (shot ${s.shot}/${s.total})`;
    case "capturing":
    case "flash":
      return `${s.state} (shot ${s.shot}/${s.total})`;
    case "strip_review":
      return `strip_review (${s.photos.length} photos, returns in ${s.auto_return_in}s)`;
    case "error":
      return `error: ${s.message}${s.recoverable ? "" : " (not recoverable)"}`;
    default:
      return s.state;
  }
}

function describeStatus(status: CameraStatus): string {
  return status.state === "error" ? `error: ${status.message}` : status.state;
}

const initial = () => ({
  screen: "select" as Screen,
  session: { state: "attract" } as SessionState,
  cameras: [] as CameraInfo[],
  cameraStatus: {} as Record<string, CameraStatus>,
  settings: null as Settings | null,
  gesture: null as GestureUpdate | null,
  eventLog: [] as LogEntry[],
  notice: null as string | null,
});

function appendLog(log: LogEntry[], kind: LogEntry["kind"], text: string): LogEntry[] {
  const entry: LogEntry = { id: nextLogId++, at: Date.now(), kind, text };
  return [...log, entry].slice(-MAX_LOG_ENTRIES);
}

export const useBooth = create<BoothState>()((set) => ({
  ...initial(),

  setScreen: (screen) => set({ screen }),

  applySession: (session) =>
    set((s) => ({
      session,
      eventLog: appendLog(s.eventLog, "session", describeSession(session)),
    })),

  applyCameraStatus: ({ camera, status }) =>
    set((s) => ({
      cameraStatus: { ...s.cameraStatus, [camera]: status },
      eventLog: appendLog(s.eventLog, "camera", `${camera}: ${describeStatus(status)}`),
    })),

  applyGesture: (gesture) => set({ gesture }),

  setCameras: (cameras) =>
    set((s) => ({
      cameras,
      // Seed statuses from the list, but never clobber a newer one from an event.
      cameraStatus: {
        ...Object.fromEntries(cameras.map((c) => [c.id, c.status])),
        ...s.cameraStatus,
      },
    })),

  setSettings: (settings) => set({ settings }),
  setNotice: (notice) => set({ notice }),
}));

/** Restores the store to its initial state (tests). */
export function resetBooth(): void {
  nextLogId = 1;
  useBooth.setState(initial());
}

export const selectedCameraId = (s: BoothState): CameraId | null =>
  s.settings?.selected_camera ?? s.cameras.find((c) => c.selected)?.id ?? null;

export const selectedCamera = (s: BoothState): CameraInfo | undefined => {
  const id = selectedCameraId(s);
  return s.cameras.find((c) => c.id === id);
};

export const selectedCameraStatus = (s: BoothState): CameraStatus | undefined => {
  const id = selectedCameraId(s);
  return id ? s.cameraStatus[id] : undefined;
};

/** What to tell the guest about a camera that cannot take a photo yet; null when it can (or is unknown). */
export function problemText(status: CameraStatus | undefined): string | null {
  switch (status?.state) {
    case "connecting":
      return "Connecting to camera…";
    case "error":
      return status.message;
    case "disconnected":
      return "Camera disconnected";
    default:
      return null;
  }
}

/**
 * The banner on the attract screen: shown exactly when the camera cannot take a photo yet. The
 * start pill is disabled while it is up, and a toast that repeats it is suppressed.
 */
export const cameraBanner = (s: BoothState): string | null =>
  s.screen === "booth" && s.session.state === "attract"
    ? problemText(selectedCameraStatus(s))
    : null;
