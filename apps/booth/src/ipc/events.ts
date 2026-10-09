import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CameraStatusEvent, SessionState } from "./types";

export const SESSION_EVENT = "session://state";
export const CAMERA_EVENT = "camera://status";

export const onSessionState = (handler: (state: SessionState) => void): Promise<UnlistenFn> =>
  listen<SessionState>(SESSION_EVENT, (event) => handler(event.payload));

export const onCameraStatus = (handler: (event: CameraStatusEvent) => void): Promise<UnlistenFn> =>
  listen<CameraStatusEvent>(CAMERA_EVENT, (event) => handler(event.payload));
