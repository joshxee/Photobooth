import { useMemo, useRef, useState } from "react";
import type { AdminEvent } from "../../shared/schemas";
import { type EventActionName, api, isNotAuthorised } from "./api";
import { useAdmin, useLoad } from "./env";
import { Link } from "./nav";
import { EventHead } from "./EventHead";
import { ConfirmDialog, ErrorNote, Loading } from "./parts";
import { qrFilename, qrSvg } from "./qr";
import { type BacklogReport, availableActions, backlogReport, confirmation } from "./rules";
import { formatDay, formatInZone } from "./time";

const LABEL: Record<EventActionName, string> = {
  open: "Open uploads",
  close: "Close uploads",
  publish: "Publish gallery",
  suspend: "Suspend gallery",
  "rotate-link": "Rotate link",
  delete: "Delete event",
  restore: "Restore event",
};

interface Pending {
  action: EventActionName;
  /** null when the devices couldn't be read (only the close warning uses it). */
  backlog: BacklogReport | null;
}

export function EventDetail({ id }: { id: string }) {
  const { env, onNotAuthorised } = useAdmin();
  const loaded = useLoad(() => api.getEvent(id), id);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [dialogFailure, setDialogFailure] = useState<unknown>(null);
  // What had focus when an action was chosen: its button is disabled while the booths are checked.
  const opener = useRef<HTMLElement | null>(null);

  if (loaded.loading) return <Loading what="event" />;
  if (!loaded.data) return loaded.error != null ? <ErrorNote error={loaded.error} /> : null;
  const event = loaded.data;
  const now = env.now();

  const run = async (action: EventActionName) => {
    setBusy(true);
    setDialogFailure(null);
    setFailure(null);
    try {
      loaded.setData(await api.eventAction(event.id, action));
      setPending(null);
    } catch (error) {
      // A conflict means the screen was stale: show the dialog's error, then catch up.
      if (pending) setDialogFailure(error);
      else setFailure(error);
      void loaded.reload();
    } finally {
      setBusy(false);
    }
  };

  const choose = async (action: EventActionName) => {
    opener.current = document.activeElement as HTMLElement | null;
    setFailure(null);
    setDialogFailure(null);
    if (action === "close") {
      // The close warning needs the booths' queues as they are now, not as of the last visit.
      setBusy(true);
      let backlog: BacklogReport | null = null;
      try {
        backlog = backlogReport((await api.listDevices()).devices, env.now());
      } catch (error) {
        if (isNotAuthorised(error)) onNotAuthorised();
      }
      setBusy(false);
      setPending({ action, backlog });
      return;
    }
    if (confirmation(action, event, null, now)) setPending({ action, backlog: null });
    else await run(action);
  };

  const dialog = pending ? confirmation(pending.action, event, pending.backlog, now) : null;

  return (
    <section>
      <EventHead event={event} now={now} current="details" />

      {event.deletedAt && (
        <div className="warning">
          <p>
            <strong>This event is deleted.</strong> Its gallery and uploads are off.{" "}
            {event.purgeAfter && (
              <>
                Restore it before <strong>{formatInZone(event.purgeAfter, event.timezone)}</strong> or its photos are deleted permanently.
              </>
            )}
          </p>
        </div>
      )}

      <div className="actions actions--wrap" role="group" aria-label="Event actions">
        {availableActions(event, now).map((action) => (
          <button
            key={action}
            type="button"
            className={`btn ${action === "delete" || action === "rotate-link" ? "btn--secondary btn--caution" : action === "restore" ? "btn--primary" : "btn--secondary"}`}
            onClick={() => void choose(action)}
            disabled={busy}
          >
            {LABEL[action]}
          </button>
        ))}
        {!event.deletedAt && (
          <Link to={`/events/${event.id}/edit`} className="btn btn--secondary">
            Edit details
          </Link>
        )}
      </div>
      {failure != null && <ErrorNote error={failure} />}

      <div className="split">
        <dl className="facts">
          <dt>Venue</dt>
          <dd>{event.venue || "—"}</dd>
          <dt>Starts</dt>
          <dd>{formatInZone(event.startsAt, event.timezone)}</dd>
          <dt>Ends</dt>
          <dd>{formatInZone(event.endsAt, event.timezone)}</dd>
          <dt>Time zone</dt>
          <dd>{event.timezone}</dd>
          <dt>Uploads close on</dt>
          <dd>
            {formatDay(event.uploadsUntil, event.timezone)}
            <span className="muted"> (90 days after the event ends)</span>
          </dd>
          {event.deletedAt && event.purgeAfter && (
            <>
              <dt>Purges on</dt>
              <dd>{formatDay(event.purgeAfter, event.timezone)}</dd>
            </>
          )}
          <dt>Photo limit</dt>
          <dd>{event.photoLimit}</dd>
          <dt>Photos</dt>
          <dd>
            {event.counts.ready} in the gallery · {event.counts.pending} pending · {event.counts.rejected} rejected · {event.counts.hidden} hidden
          </dd>
        </dl>
        {!event.deletedAt && <QrPanel event={event} />}
      </div>

      {pending && dialog && (
        <ConfirmDialog
          confirmation={dialog}
          busy={busy}
          restoreFocus={opener.current}
          error={dialogFailure}
          onConfirm={() => void run(pending.action)}
          onCancel={() => {
            setPending(null);
            setDialogFailure(null);
          }}
        />
      )}
    </section>
  );
}

function QrPanel({ event }: { event: AdminEvent }) {
  const { env } = useAdmin();
  const [status, setStatus] = useState<string | null>(null);
  const svg = useMemo(() => qrSvg(event.galleryUrl), [event.galleryUrl]);

  const copy = async () => {
    try {
      await env.copyText(event.galleryUrl);
      setStatus("Link copied.");
    } catch {
      setStatus("Couldn't copy. Select the link and copy it by hand.");
    }
  };
  const downloadSvg = () => {
    env.saveFile(new Blob([svg], { type: "image/svg+xml" }), qrFilename(event.name, "svg"));
    setStatus("SVG downloaded.");
  };
  const downloadPng = async () => {
    try {
      env.saveFile(await env.png(event.galleryUrl), qrFilename(event.name, "png"));
      setStatus("PNG downloaded.");
    } catch {
      setStatus("Couldn't make the PNG in this browser. Download the SVG instead.");
    }
  };

  return (
    <div className="qr">
      <h2>Event QR code</h2>
      <div className="qr__code" role="img" aria-label={`QR code for the ${event.name} gallery link`} dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="hint">
        Opens the whole event gallery. It is the same link as the booth's QR, so rotating the link stops both. Print the SVG for signage.
      </p>
      {event.galleryStatus !== "LIVE" && <p className="hint">The gallery isn't live, so guests who scan this see "unavailable" until you publish.</p>}
      <label className="visually-hidden" htmlFor="gallery-link">
        Gallery link
      </label>
      <input id="gallery-link" className="link-input" type="text" readOnly value={event.galleryUrl} onFocus={(e) => e.target.select()} />
      <div className="actions actions--wrap">
        <button type="button" className="btn btn--secondary" onClick={() => void copy()}>
          Copy link
        </button>
        <button type="button" className="btn btn--secondary" onClick={downloadSvg}>
          Download SVG
        </button>
        <button type="button" className="btn btn--secondary" onClick={() => void downloadPng()}>
          Download PNG
        </button>
      </div>
      <p className="muted" role="status">
        {status}
      </p>
    </div>
  );
}
