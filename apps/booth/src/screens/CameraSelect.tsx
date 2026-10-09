import { useEffect, useState } from "react";

import { cameraSelect } from "../ipc";
import { errorMessage, refreshCameras } from "../store/bridge";
import { useBooth } from "../store/store";

const DESCRIPTIONS: Record<string, string> = {
  device: "Use your device's built-in camera",
  sony_usb: "Wired USB • PC Remote mode • Full-resolution JPEG",
  test: "Test mode • Fast capture • No hardware required",
};

/** How often to re-check availability so a camera plugged in while this screen is open shows up. */
const REFRESH_MS = 2000;

export function CameraSelect() {
  const cameras = useBooth((s) => s.cameras);
  const settings = useBooth((s) => s.settings);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshCameras();
    const timer = setInterval(() => void refreshCameras(), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const selected = cameras.find((c) => c.id === settings?.selected_camera);
  const canContinue = Boolean(selected?.available) && !busy;

  const choose = async (id: string) => {
    setBusy(true);
    try {
      await cameraSelect(id);
      useBooth.getState().setSettings({
        ...(useBooth.getState().settings as NonNullable<typeof settings>),
        selected_camera: id,
      });
      await refreshCameras();
    } catch (error) {
      useBooth.getState().setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="select">
      <header className="select__header">
        <h1>Select Camera</h1>
        <button
          type="button"
          className="icon-button"
          aria-label="Settings"
          onClick={() => useBooth.getState().setScreen("settings")}
        >
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19.14 12.94a7.07 7.07 0 0 0 .05-.94 7 7 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7 7 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7 7 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"
            />
          </svg>
        </button>
      </header>

      <ul className="select__list">
        {cameras.map((camera) => {
          const isSelected = camera.id === settings?.selected_camera;
          return (
            <li key={camera.id}>
              <button
                type="button"
                className={`card${isSelected ? " is-selected" : ""}${
                  camera.available ? "" : " is-unavailable"
                }`}
                aria-pressed={isSelected}
                aria-disabled={!camera.available}
                disabled={busy}
                onClick={() => (camera.available ? void choose(camera.id) : undefined)}
              >
                <span className="card__name">{camera.name}</span>
                <span className="card__desc">
                  {camera.available
                    ? (DESCRIPTIONS[camera.id] ?? "")
                    : (camera.reason ?? "Not available")}
                </span>
                {isSelected && camera.available && (
                  <span className="card__check" role="img" aria-label="Selected">
                    ✓
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="pill pill--large select__continue"
        disabled={!canContinue}
        onClick={() => useBooth.getState().setScreen("booth")}
      >
        <span className="pill__dot" aria-hidden="true" />
        <span className="pill__label">Continue →</span>
      </button>
    </main>
  );
}
