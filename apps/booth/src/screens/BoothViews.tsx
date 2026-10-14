// The visual states of a session. Copy and layout are ported verbatim from the original
// Knockbox UI (composeApp/.../ui/knockbox) so the existing Maestro flows can be re-targeted
// instead of rewritten. Every string here is part of that contract.

import type { CSSProperties, RefObject } from "react";

import { FillButton } from "../components/FillButton";
import { PhotoStrip } from "../components/PhotoStrip";
import { ShotPips } from "../components/ShotPips";
import type { Rect } from "../ipc/frameGeometry";
import type { GestureUpdate } from "../ipc/types";
import { uiConfig } from "../uiConfig";

/** What the attract screen needs to guide a guest's palm into the box. */
export interface PalmGuide {
  /** The latest update from Rust (null until the first). */
  update: GestureUpdate | null;
  /** The box element; the caller reports where it sits so Rust knows where to look. */
  boxRef: RefObject<HTMLDivElement | null>;
}

export function Attract({
  totalShots,
  onStart,
  disabled = false,
  palm,
}: {
  totalShots: number;
  onStart: () => void;
  /** The camera cannot take a photo yet: the pill is greyed out and does nothing. */
  disabled?: boolean;
  /** Start by holding a palm in a box (with tap as a fallback); otherwise tap only. */
  palm?: PalmGuide;
}) {
  const shots = (
    <div className="attract__shots">
      <ShotPips total={totalShots} current={0} variant="attract" />
      <span className="mono">{totalShots} SHOTS</span>
    </div>
  );

  if (palm) {
    return (
      <section className="view view--attract view--palm" aria-label="Attract">
        <div className="attract__copy">
          <h1 className="attract__headline">Put your palm in the box to start the photobooth</h1>
        </div>
        <PalmBox guide={palm} />
        <div className="attract__tap">
          <FillButton
            label="Tap here to start"
            size="medium"
            fillMs={uiConfig.fillMs}
            onFire={onStart}
            disabled={disabled}
          />
        </div>
        {shots}
      </section>
    );
  }

  return (
    <section className="view view--attract" aria-label="Attract">
      <div className="attract__center">
        <h1 className="attract__headline">Welcome to the booth</h1>
        <FillButton
          label="Tap to start photoshoot"
          size="large"
          fillMs={uiConfig.fillMs}
          onFire={onStart}
          disabled={disabled}
        />
      </div>

      {shots}
    </section>
  );
}

/**
 * The box a guest holds a palm in. It is a window onto the live preview (everything outside it
 * is dimmed). White while idle; a palm in it turns it green, and a ring runs around it from the
 * top while the hold completes (Rust decides when; the ring just mirrors its clock). It carries
 * no text or picture: the headline says what to do, the live video shows whose hand it is, and
 * the colour says whether it is working.
 */
function PalmBox({ guide }: { guide: PalmGuide }) {
  const seen = guide.update?.palm != null;
  const holding = guide.update?.holding ?? false;
  const holdMs = guide.update?.hold_ms ?? 1000;
  return (
    <div
      ref={guide.boxRef}
      className={`palmbox${seen ? " is-seen" : ""}${holding ? " is-holding" : ""}`}
      style={{ "--hold-ms": `${holdMs}ms` } as CSSProperties}
      role="img"
      aria-label="Hold your palm up inside this box to start"
    >
      <svg className="palmbox__art" viewBox="0 0 400 500" aria-hidden="true">
        {/* Both strokes are inset by half their width, so their outer edge is exactly the edge of
            the box (the 36-unit corner radius is the box's own 9 %) and nothing shows outside. */}
        <rect className="palmbox__track" x="2.5" y="2.5" width="395" height="495" rx="33.5" />
        {/* The ring: the same rounded rectangle, started at the top centre, running clockwise. */}
        <path
          className="palmbox__progress"
          pathLength="1"
          d="M200 7H364A29 29 0 0 1 393 36V464A29 29 0 0 1 364 493H36A29 29 0 0 1 7 464V36A29 29 0 0 1 36 7Z"
        />
      </svg>
    </div>
  );
}

/**
 * Marks the palm Rust found on the live preview with a small dot at the centre of the hand.
 * (Not a ring or a rectangle: those looked like a second box.) `rect` is the palm in screen
 * fractions.
 */
export function PalmHighlight({ rect }: { rect: Rect }) {
  return (
    <div
      className="palm-highlight"
      aria-hidden="true"
      style={{
        left: `${(rect.x + rect.w / 2) * 100}%`,
        top: `${(rect.y + rect.h / 2) * 100}%`,
      }}
    />
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
