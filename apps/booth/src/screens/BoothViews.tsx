// The visual states of a session. Copy and layout are ported verbatim from the original
// Knockbox UI (composeApp/.../ui/knockbox) so the existing Maestro flows can be re-targeted
// instead of rewritten. Every string here is part of that contract.

import { FillButton } from "../components/FillButton";
import { PhotoStrip } from "../components/PhotoStrip";
import { ShotPips } from "../components/ShotPips";
import { uiConfig } from "../uiConfig";

export function Attract({ totalShots, onStart }: { totalShots: number; onStart: () => void }) {
  return (
    <section className="view view--attract" aria-label="Attract">
      <div className="attract__brand">
        <span className="dot" aria-hidden="true" />
        <span className="mono">KNOCKBOX · PHOTOBOOTH</span>
      </div>

      <div className="attract__center">
        <h1 className="attract__headline">
          Welcome to the booth —<br />
          raise your hand
        </h1>
        <p className="attract__or mono">or</p>
        <FillButton
          label="Tap to start photoshoot"
          size="large"
          fillMs={uiConfig.fillMs}
          onFire={onStart}
        />
      </div>

      <div className="attract__shots">
        <ShotPips total={totalShots} current={0} variant="attract" />
        <span className="mono">{totalShots} SHOTS</span>
      </div>
    </section>
  );
}

export function Arming() {
  return (
    <section className="view view--arming" aria-label="Getting ready" role="status">
      <p className="mono">GETTING THE CAMERA READY…</p>
    </section>
  );
}

export function Countdown({
  shot,
  total,
  remaining,
}: {
  shot: number;
  total: number;
  remaining: number;
}) {
  return (
    <section className="view view--countdown" aria-label="Countdown">
      <div className="countdown__top">
        <span className="countdown__arrow" aria-hidden="true">
          ↑
        </span>
        <h1 className="countdown__prompt">Look at the lens</h1>
      </div>
      <div className="countdown__center">
        {/* `key` restarts the pop animation on every tick. */}
        <span
          key={`${shot}-${remaining}`}
          className="countdown__numeral"
          aria-live="polite"
          aria-label={`Photo ${shot} of ${total}, ${remaining}`}
        >
          {remaining > 0 ? remaining : "·"}
        </span>
      </div>
      <ShotPips total={total} current={shot} variant="countdown" />
    </section>
  );
}

/** Shown while the camera captures and then for the flash itself. */
export function Flash({ fading }: { fading: boolean }) {
  return (
    <section
      className={`view view--flash${fading ? " is-fading" : ""}`}
      aria-label={fading ? "Flash" : "Capturing"}
    />
  );
}

export function StripReview({
  sessionId,
  photos,
  autoReturnIn,
  autoReturnTotal,
  headline,
  date,
  onTakeAnother,
}: {
  sessionId: string;
  photos: number[];
  autoReturnIn: number;
  autoReturnTotal: number;
  headline: string;
  date: string;
  onTakeAnother: () => void;
}) {
  const pct = autoReturnTotal > 0 ? Math.min(1, Math.max(0, autoReturnIn / autoReturnTotal)) : 0;
  return (
    <section className="view view--review" aria-label="Photo strip">
      <div className="review__body">
        <div className="review__strip">
          <PhotoStrip sessionId={sessionId} photos={photos} headline={headline} date={date} />
        </div>
        <div className="review__text">
          <p className="mono review__saved">
            VIRTUAL PHOTO STRIP SAVED — COPIES WILL BE AVAILABLE AFTER THE EVENT
          </p>
          <h1 className="review__headline">Looking good.</h1>
          <FillButton
            label="Take another strip →"
            fillMs={uiConfig.fillMs}
            onFire={onTakeAnother}
          />
        </div>
      </div>

      <footer className="review__timer">
        <div className="review__timer-row mono">
          <span>
            <span className="dot dot--small" aria-hidden="true" />
            RETURNING TO PHOTOBOOTH
          </span>
          <span>{autoReturnIn}s</span>
        </div>
        <div
          className="review__bar"
          role="progressbar"
          aria-label="Time until returning to the start"
          aria-valuemin={0}
          aria-valuemax={autoReturnTotal}
          aria-valuenow={autoReturnIn}
        >
          <div className="review__bar-fill" style={{ width: `${pct * 100}%` }} />
        </div>
      </footer>
    </section>
  );
}

export function SessionError({
  message,
  recoverable,
  onRetry,
  onHome,
}: {
  message: string;
  recoverable: boolean;
  onRetry: () => void;
  onHome: () => void;
}) {
  return (
    <section className="view view--error" role="alert" aria-label="Problem">
      <h1 className="error__title">Something went wrong</h1>
      <p className="error__message">{message}</p>
      <div className="error__actions">
        {recoverable && (
          <button type="button" className="pill pill--medium" onClick={onRetry}>
            <span className="pill__dot" aria-hidden="true" />
            <span className="pill__label">Try again</span>
          </button>
        )}
        <button type="button" className="pill pill--medium pill--outline" onClick={onHome}>
          <span className="pill__label">Back to start</span>
        </button>
      </div>
    </section>
  );
}
