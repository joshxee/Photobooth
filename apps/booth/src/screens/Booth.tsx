import { useCallback, useEffect, useRef } from "react";

import {
  cameraConnect,
  cameraDisconnect,
  sessionReturnHome,
  sessionStart,
  sessionTakeAnother,
  startLiveView,
} from "../ipc";
import { setKeepScreenOn } from "../platform";
import { errorMessage } from "../store/bridge";
import { selectedCamera, selectedCameraStatus, useBooth } from "../store/store";
import { Arming, Attract, Countdown, Flash, SessionError, StripReview } from "./BoothViews";
import { DevPanel } from "./DevPanel";

// Camera start/stop calls must not overlap (a retry disconnecting while a connect is mid-way
// would race), so they run strictly one after another.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.catch(() => undefined);
  return run;
}

/** Connects the active camera and streams its live view to `canvasRef`. */
function useCameraStream(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const stopStream = useRef<null | (() => Promise<void>)>(null);

  const start = useCallback(
    () =>
      enqueue(async () => {
        try {
          await cameraConnect();
          const canvas = canvasRef.current;
          if (!canvas) return;
          stopStream.current = await startLiveView(canvas);
        } catch (error) {
          useBooth.getState().setNotice(errorMessage(error));
        }
      }),
    [canvasRef],
  );

  const stop = useCallback(
    () =>
      enqueue(async () => {
        const stopping = stopStream.current;
        stopStream.current = null;
        await stopping?.().catch(() => undefined);
      }),
    [],
  );

  useEffect(() => {
    void start();
    return () => {
      void stop().then(() => enqueue(() => cameraDisconnect().catch(() => undefined)));
    };
  }, [start, stop]);

  const retry = useCallback(async () => {
    await stop();
    await start();
  }, [start, stop]);

  return { retry };
}

export function Booth() {
  const session = useBooth((s) => s.session);
  const settings = useBooth((s) => s.settings);
  const camera = useBooth(selectedCamera);
  const status = useBooth(selectedCameraStatus);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { retry } = useCameraStream(canvasRef);

  useEffect(() => {
    void setKeepScreenOn(true);
    return () => void setKeepScreenOn(false);
  }, []);

  const leave = useCallback(() => useBooth.getState().setScreen("select"), []);
  const guard = useCallback(
    (action: () => Promise<void>) => () =>
      void action().catch((e) => useBooth.getState().setNotice(errorMessage(e))),
    [],
  );

  const native = camera?.preview === "native";
  const mirror = settings?.mirror_preview ?? true;
  const connectionProblem =
    status?.state === "error" || status?.state === "disconnected" || status?.state === "connecting";

  return (
    <main className={`booth booth--${native ? "native" : "channel"}`} data-state={session.state}>
      <div className={`booth__preview${mirror ? " is-mirrored" : ""}`} aria-hidden="true">
        <canvas ref={canvasRef} className="booth__canvas" />
      </div>

      {session.state === "attract" && (
        <Attract
          totalShots={settings?.number_of_photos ?? 3}
          onStart={() => sessionStart().catch((e) => useBooth.getState().setNotice(errorMessage(e)))}
        />
      )}
      {session.state === "arming" && <Arming />}
      {session.state === "countdown" && (
        <Countdown shot={session.shot} total={session.total} remaining={session.remaining} />
      )}
      {session.state === "capturing" && <Flash fading={false} />}
      {session.state === "flash" && <Flash fading />}
      {session.state === "strip_review" && (
        <StripReview
          sessionId={session.session_id}
          photos={session.photos}
          autoReturnIn={session.auto_return_in}
          autoReturnTotal={settings?.strip_display_seconds ?? 12}
          headline={settings?.headline ?? ""}
          date={settings?.event_date ?? ""}
          onTakeAnother={guard(sessionTakeAnother)}
        />
      )}
      {session.state === "error" && (
        <SessionError
          message={session.message}
          recoverable={session.recoverable}
          onRetry={guard(sessionStart)}
          onHome={guard(sessionReturnHome)}
        />
      )}

      {session.state === "attract" && connectionProblem && (
        <div className="banner" role="status">
          <span>
            {status?.state === "connecting"
              ? "Connecting to camera…"
              : status?.state === "error"
                ? status.message
                : "Camera disconnected"}
          </span>
          {status?.state !== "connecting" && (
            <button type="button" className="banner__button" onClick={() => void retry()}>
              Retry connection
            </button>
          )}
        </div>
      )}

      {session.state === "attract" && (
        <button type="button" className="booth__exit" onClick={leave}>
          Back
        </button>
      )}

      {camera?.id === "test" && <DevPanel />}
    </main>
  );
}
