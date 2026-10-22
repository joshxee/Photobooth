// The operator's upload queue in Settings: counts, free space, why uploads are stopped, and
// the needs-attention list with retry and delete. Rust decides everything; deleting the
// booth's copy is confirmed here first (the camera's SD card still has the original).

import { useEffect, useState } from "react";

import { outboxDismiss, outboxItems, outboxRetry, type OutboxEntry } from "../ipc";
import { errorMessage } from "../store/bridge";
import { useBooth } from "../store/store";
import { entryTitle, formatBytes } from "./uploadText";

/** Runs a queue command; a refusal becomes a notice. */
async function run(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    useBooth.getState().setNotice(errorMessage(error));
  }
}

function ConfirmDelete({ entry, done }: { entry: OutboxEntry; done: () => void }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    await run(() => outboxDismiss(entry.id));
    setBusy(false);
    done();
  };
  return (
    <div className="portal__confirm">
      <h3 className="portal__title">Delete this photo from the booth?</h3>
      <p>{entryTitle(entry)}</p>
      <p className="portal__hint">
        It won't be uploaded to the gallery. The camera's SD card still has the original.
      </p>
      <div className="portal__actions">
        <button
          type="button"
          className="pill pill--medium"
          disabled={busy}
          onClick={() => void remove()}
        >
          Delete from booth
        </button>
        <button
          type="button"
          className="pill pill--medium pill--outline"
          disabled={busy}
          onClick={done}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Entry({ entry, onDelete }: { entry: OutboxEntry; onDelete: () => void }) {
  return (
    <li className="queue__entry">
      <span className="queue__title">{entryTitle(entry)}</span>
      <span className="queue__reason">{entry.reason}</span>
      <span className="portal__actions">
        {entry.can_retry && (
          <button
            type="button"
            className="pill pill--medium"
            onClick={() => void run(() => outboxRetry(entry.id))}
          >
            Retry
          </button>
        )}
        {entry.kind === "not_queued" ? (
          <button
            type="button"
            className="pill pill--medium pill--outline"
            onClick={() => void run(() => outboxDismiss(entry.id))}
          >
            Dismiss
          </button>
        ) : (
          <button type="button" className="pill pill--medium pill--outline" onClick={onDelete}>
            Delete…
          </button>
        )}
      </span>
    </li>
  );
}

export function UploadQueue() {
  const status = useBooth((s) => s.outbox);
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [deleting, setDeleting] = useState<OutboxEntry | null>(null);

  // The list is re-read whenever the counts change (a `portal://outbox` event).
  useEffect(() => {
    if (!status?.available) return;
    let current = true;
    outboxItems()
      .then((list) => current && setEntries(list))
      .catch((error: unknown) => useBooth.getState().setNotice(errorMessage(error)));
    return () => {
      current = false;
    };
  }, [status]);

  let body;
  if (!status) {
    body = <p role="status">Checking the upload queue…</p>;
  } else if (!status.available) {
    body = (
      <p className="portal__problem" role="alert">
        This booth can't queue photos for upload (its storage couldn't be opened). Photos stay on
        the camera's SD card.
      </p>
    );
  } else if (deleting) {
    body = <ConfirmDelete entry={deleting} done={() => setDeleting(null)} />;
  } else {
    body = (
      <>
        <p className="portal__state">
          Queued {status.queued} · Uploading {status.uploading} · Needs attention{" "}
          {status.needs_attention}
        </p>
        {status.revoked && (
          <p className="portal__problem" role="alert">
            The portal refused this booth (it may have been revoked). Photos stay queued here.
            Unenrol, then enrol again with a new code to send them.
          </p>
        )}
        {status.offline && !status.revoked && (
          <p className="portal__hint">
            Offline: photos wait here and upload when the portal can be reached.
          </p>
        )}
        {status.low_disk && status.free_bytes !== null ? (
          <p className="portal__problem" role="alert">
            Storage is low: {formatBytes(status.free_bytes)} free. Queued photos are kept until
            they upload; nothing is deleted to make room.
          </p>
        ) : (
          status.free_bytes !== null && (
            <p className="portal__hint">Free storage: {formatBytes(status.free_bytes)}</p>
          )
        )}
        {entries.length === 0 ? (
          <p className="portal__hint">Nothing needs attention.</p>
        ) : (
          <ul className="queue__list" aria-label="Needs attention">
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} onDelete={() => setDeleting(entry)} />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <fieldset className="settings__group portal">
      <legend>Upload Queue</legend>
      {body}
    </fieldset>
  );
}
