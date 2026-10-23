// Small shared pieces: the modal dialog, the confirmation built on it, status chips and errors.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { describeError } from "./api";
import type { Confirmation, Chip as ChipData } from "./rules";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

/**
 * A modal. Focus moves in (to `[data-autofocus]` when there is one, so a destructive dialog opens
 * on Cancel), Tab stays inside, Escape closes, and focus returns to what opened it.
 */
export function Dialog({
  title,
  onClose,
  restoreFocus,
  closeOnBackdrop = true,
  children,
}: {
  title: string;
  onClose(): void;
  restoreFocus?: HTMLElement | null;
  /** False for a dialog whose content can't be shown again: a stray click mustn't lose it. */
  closeOnBackdrop?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A caller that disabled its button while preparing the dialog passes it in: by now focus has left it.
    const opener = restoreFocus ?? (document.activeElement as HTMLElement | null);
    const first = box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const [first, last] = [items[0], items[items.length - 1]];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="backdrop" onMouseDown={(e) => closeOnBackdrop && e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  confirmation,
  busy,
  error,
  restoreFocus,
  onConfirm,
  onCancel,
}: {
  confirmation: Confirmation;
  busy: boolean;
  error: unknown;
  restoreFocus?: HTMLElement | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Dialog title={confirmation.title} onClose={busy ? () => {} : onCancel} restoreFocus={restoreFocus}>
      {confirmation.paragraphs.map((p) => (
        <p key={p}>{p}</p>
      ))}
      {confirmation.warning && (
        <div className="warning" role="alert">
          <p>
            <strong>{confirmation.warning}</strong>
          </p>
          {confirmation.items && (
            <ul>
              {confirmation.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error != null && <ErrorNote error={error} />}
      <div className="actions">
        <button type="button" className="btn btn--secondary" data-autofocus onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`btn ${confirmation.danger ? "btn--danger" : "btn--primary"}`} onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : confirmation.confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

export function Chip({ chip }: { chip: ChipData }) {
  return <span className={`chip chip--${chip.tone}`}>{chip.label}</span>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <p className="error" role="alert">
      {describeError(error)}
    </p>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="muted" role="status">
      Loading {what}…
    </p>
  );
}
