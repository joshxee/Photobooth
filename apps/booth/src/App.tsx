import { useEffect } from "react";

import { onBackPressed, setImmersive } from "./platform";
import { Booth } from "./screens/Booth";
import { CameraSelect } from "./screens/CameraSelect";
import { Settings } from "./screens/Settings";
import { startBridge } from "./store/bridge";
import { useBooth } from "./store/store";

const NOTICE_MS = 6000;

function Notice() {
  const notice = useBooth((s) => s.notice);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useBooth.getState().setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  return (
    <div className="notice" role="alert">
      <span>{notice}</span>
      <button
        type="button"
        className="notice__dismiss"
        aria-label="Dismiss"
        onClick={() => useBooth.getState().setNotice(null)}
      >
        ×
      </button>
    </div>
  );
}

export function App() {
  const screen = useBooth((s) => s.screen);

  useEffect(() => {
    let detach: (() => void) | undefined;
    let unsubscribeBack: (() => void) | undefined;
    let disposed = false;

    void startBridge().then((fn) => (disposed ? fn() : (detach = fn)));
    // The Android back button leaves the booth (or settings) instead of closing the app —
    // the original app had no way out of a session at all.
    void onBackPressed(() => {
      const { screen: current, setScreen } = useBooth.getState();
      if (current === "booth" || current === "settings") setScreen("select");
    }).then((fn) => (disposed ? fn() : (unsubscribeBack = fn)));
    void setImmersive(true);

    return () => {
      disposed = true;
      detach?.();
      unsubscribeBack?.();
    };
  }, []);

  return (
    <>
      {screen === "select" && <CameraSelect />}
      {screen === "booth" && <Booth />}
      {screen === "settings" && <Settings />}
      <Notice />
    </>
  );
}
