// Connects the IPC layer to the store: backend events in, initial snapshots at startup.

import {
  cameraList,
  onCameraStatus,
  onGestureUpdate,
  onSessionState,
  sessionState,
  settingsGet,
} from "../ipc";
import { useBooth } from "./store";

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Starts listening to `session://state` and `camera://status`, then loads the initial
 * snapshots (the WebView may load, or reload in dev, while a session is running). Events are
 * attached first so nothing is missed; a snapshot never overwrites a newer event.
 * Returns a function that detaches the listeners.
 */
export async function startBridge(): Promise<() => void> {
  const store = useBooth.getState();
  let sawSessionEvent = false;

  const unlisten = await Promise.all([
    onSessionState((state) => {
      sawSessionEvent = true;
      useBooth.getState().applySession(state);
    }),
    onCameraStatus((event) => useBooth.getState().applyCameraStatus(event)),
    onGestureUpdate((update) => useBooth.getState().applyGesture(update)),
  ]);

  try {
    const [session, cameras, settings] = await Promise.all([
      sessionState(),
      cameraList(),
      settingsGet(),
    ]);
    if (!sawSessionEvent) store.applySession(session);
    store.setCameras(cameras);
    store.setSettings(settings);
  } catch (error) {
    store.setNotice(errorMessage(error));
  }

  // Unlistening can reject (e.g. the webview is already tearing down); never let that escape.
  return () => unlisten.forEach((fn) => void Promise.resolve(fn()).catch(() => undefined));
}

/** Re-reads the camera list (availability changes as cameras are plugged in). */
export async function refreshCameras(): Promise<void> {
  try {
    useBooth.getState().setCameras(await cameraList());
  } catch (error) {
    useBooth.getState().setNotice(errorMessage(error));
  }
}
