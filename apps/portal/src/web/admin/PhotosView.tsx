// The Photos tab of an event (DESIGN §12): every photo by state, a viewer for the full-size file with
// Hide, Unhide and "Delete permanently". Previews and full-size files come from the admin media
// proxy (private, no-store), so they work for pending, rejected and hidden photos too.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AdminEvent, AdminPhoto, PhotoState } from "../../shared/schemas";
import { ApiError, api, mediaUrl } from "./api";
import { EventHead } from "./EventHead";
import { useAdmin, useLoad } from "./env";
import { type Page, usePaged } from "./paged";
import { ConfirmDialog, Chip, Dialog, ErrorNote, Loading } from "./parts";
import { NO_FILTER, type PhotoFilter, filterQuery, matchesFilter, neighbour, photoChips, photoLabel } from "./photos";
import { photoDeleteConfirmation } from "./rules";
import { formatClock, formatInZone } from "./time";

const STATE_LABEL: Record<"ALL" | PhotoState, string> = { ALL: "All photos", READY: "In the gallery", PENDING: "Pending", REJECTED: "Rejected" };

export function PhotosView({ id }: { id: string }) {
  const { env } = useAdmin();
  const loaded = useLoad(() => api.getEvent(id), id);
  const [filter, setFilter] = useState<PhotoFilter>(NO_FILTER);
  const list = usePaged<AdminPhoto>(
    async (cursor): Promise<Page<AdminPhoto>> => {
      const page = await api.listPhotos(id, { ...filterQuery(filter), cursor });
      return { items: page.photos, next: page.nextCursor };
    },
    `${id}:${filter.state}:${filter.visibility}`,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lastOpened = useRef<string | null>(null);

  // After the viewer closes, focus goes back to the photo that was open, or to the list's heading
  // when that photo is gone.
  useEffect(() => {
    if (selectedId !== null) {
      lastOpened.current = selectedId;
      return;
    }
    if (lastOpened.current === null) return;
    const tile = [...document.querySelectorAll<HTMLElement>("[data-photo]")].find((t) => t.dataset.photo === lastOpened.current);
    (tile ?? heading.current)?.focus();
    lastOpened.current = null;
  }, [selectedId]);

  if (loaded.loading) return <Loading what="event" />;
  if (!loaded.data) return loaded.error != null ? <ErrorNote error={loaded.error} /> : null;
  const event = loaded.data;
  const now = env.now();
  const items = list.items;
  const index = selectedId === null ? -1 : items.findIndex((p) => p.id === selectedId);
  const selected = index >= 0 ? items[index]! : null;

  // The viewer moves on only if it is still on the photo that left: the admin may have stepped to
  // another photo while the request ran.
  const leave = (photoId: string) => {
    const next = neighbour(items.map((x) => x.id), photoId);
    setSelectedId((current) => (current === photoId ? next : current));
    list.update((all) => all.filter((x) => x.id !== photoId));
  };
  const changed = (p: AdminPhoto) => {
    if (matchesFilter(p, filter)) list.update((all) => all.map((x) => (x.id === p.id ? p : x)));
    else leave(p.id);
    void loaded.reload();
  };
  const removed = (photoId: string) => {
    leave(photoId);
    void loaded.reload();
  };

  return (
    <section>
      <EventHead event={event} now={now} current="photos" />
      {event.deletedAt && (
        <div className="warning">
          <p>
            <strong>This event is deleted.</strong> Guests can't see anything, but you can still hide or delete its photos until it is purged.
          </p>
        </div>
      )}

      <div className="head">
        <h2 tabIndex={-1} ref={heading}>
          Photos
        </h2>
        <button type="button" className="btn btn--secondary btn--small" onClick={() => void Promise.all([list.refresh(), loaded.reload()])}>
          Refresh
        </button>
      </div>

      <div className="filters">
        <div className="field">
          <label htmlFor="photo-state">Show</label>
          <select id="photo-state" value={filter.state} onChange={(e) => setFilter({ ...filter, state: e.target.value as PhotoFilter["state"] })}>
            {(Object.keys(STATE_LABEL) as (keyof typeof STATE_LABEL)[]).map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
                {countFor(event, s)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="photo-visibility">Visibility</label>
          <select id="photo-visibility" value={filter.visibility} onChange={(e) => setFilter({ ...filter, visibility: e.target.value as PhotoFilter["visibility"] })}>
            <option value="all">Hidden and visible</option>
            <option value="visible">Visible only</option>
            <option value="hidden">Hidden only{event.counts.hidden > 0 ? ` (${event.counts.hidden})` : ""}</option>
          </select>
        </div>
      </div>

      {list.loading && <Loading what="photos" />}
      {list.error != null && <ErrorNote error={list.error} />}
      {!list.loading && list.error == null && items.length === 0 && (
        <p className="muted">{filter.state === "ALL" && filter.visibility === "all" ? "This event has no photos yet." : "No photos match these filters."}</p>
      )}
      {items.length > 0 && (
        <ul className="photo-grid" aria-label="Photos">
          {items.map((p) => (
            <li key={p.id}>
              <Tile photo={p} event={event} onOpen={() => setSelectedId(p.id)} />
            </li>
          ))}
        </ul>
      )}
      {list.next !== null && (
        <div className="actions actions--wrap">
          <button type="button" className="btn btn--secondary" onClick={() => void list.loadMore()} disabled={list.loadingMore}>
            {list.loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}

      {selected && (
        <Viewer
          photo={selected}
          event={event}
          position={index + 1}
          total={items.length}
          hasMore={list.next !== null}
          onPrevious={index > 0 ? () => setSelectedId(items[index - 1]!.id) : null}
          onNext={index < items.length - 1 ? () => setSelectedId(items[index + 1]!.id) : null}
          onClose={() => setSelectedId(null)}
          onChanged={changed}
          onRemoved={removed}
        />
      )}
    </section>
  );
}

function countFor(event: AdminEvent, s: "ALL" | PhotoState): string {
  const c = event.counts;
  const n = s === "ALL" ? c.ready + c.pending + c.rejected : s === "READY" ? c.ready : s === "PENDING" ? c.pending : c.rejected;
  return ` (${n})`;
}

function Tile({ photo, event, onOpen }: { photo: AdminPhoto; event: AdminEvent; onOpen(): void }) {
  const [missing, setMissing] = useState(false);
  const chips = photoChips(photo);
  return (
    <button
      type="button"
      className={`tile${photo.hidden ? " tile--hidden" : ""}`}
      data-photo={photo.id}
      onClick={onOpen}
      aria-label={`Open photo: ${photoLabel(photo)}${chips.length > 0 ? `, ${chips.map((c) => c.label.toLowerCase()).join(", ")}` : ""}`}
    >
      <span className="tile__image">
        {missing ? (
          <span className="muted">No preview</span>
        ) : (
          <img src={mediaUrl(photo.id, "thumb")} alt="" loading="lazy" width={photo.width} height={photo.height} onError={() => setMissing(true)} />
        )}
      </span>
      <span className="tile__caption">
        {formatClock(photo.capturedAt, event.timezone)} · shot {photo.shot}
      </span>
      {chips.length > 0 && (
        <span className="chips">
          {chips.map((c) => (
            <Chip key={c.label} chip={c} />
          ))}
        </span>
      )}
    </button>
  );
}

function Viewer({
  photo,
  event,
  position,
  total,
  hasMore,
  onPrevious,
  onNext,
  onClose,
  onChanged,
  onRemoved,
}: {
  photo: AdminPhoto;
  event: AdminEvent;
  position: number;
  total: number;
  hasMore: boolean;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onClose(): void;
  onChanged(p: AdminPhoto): void;
  onRemoved(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ id: string; error: unknown; note: string | null } | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<unknown>(null);
  // What had focus when the confirmation opened: the Delete button, which is disabled while it works.
  const opener = useRef<HTMLElement | null>(null);

  const mine = outcome?.id === photo.id ? outcome : null;
  const chips = photoChips(photo);

  const toggle = async () => {
    const hide = !photo.hidden;
    setBusy(true);
    setOutcome(null);
    try {
      const updated = await (hide ? api.hidePhoto(photo.id) : api.unhidePhoto(photo.id));
      setOutcome({
        id: photo.id,
        error: null,
        note: hide ? "Hidden. Guests can no longer see this photo; Unhide brings it back." : "Unhidden. Guests can see this photo again.",
      });
      onChanged(updated);
    } catch (error) {
      setOutcome({ id: photo.id, error, note: null });
    } finally {
      setBusy(false);
    }
  };

  const destroy = async () => {
    setBusy(true);
    setDeleteFailure(null);
    try {
      await api.deletePhoto(photo.id);
      setConfirming(false);
      onRemoved(photo.id);
    } catch (error) {
      // Already gone (another admin, or a retry after a lost answer): the goal is met.
      if (error instanceof ApiError && error.code === "not_found") {
        setConfirming(false);
        onRemoved(photo.id);
      } else setDeleteFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" && onPrevious) onPrevious();
    else if (e.key === "ArrowRight" && onNext) onNext();
  };

  return (
    <>
      <Dialog
        title={`Photo ${position} of ${total}${hasMore ? "+" : ""}`}
        onClose={onClose}
        wide
        refocusOn={`${busy}:${onPrevious !== null}:${onNext !== null}`}
      >
        <div onKeyDown={onKeyDown} className="viewer">
          <div className="viewer__image">
            {missing === photo.id ? (
              <p className="muted">The full-size file hasn't been stored. A photo that is still uploading, or was rejected, may have none.</p>
            ) : (
              <img src={mediaUrl(photo.id, "hd")} alt={`Photo: ${photoLabel(photo)}`} onError={() => setMissing(photo.id)} />
            )}
          </div>
          <dl className="facts facts--compact">
            <dt>State</dt>
            <dd>
              {photo.state}
              {photo.rejectReason && <span className="muted"> ({photo.rejectReason})</span>}
              {chips.some((c) => c.label === "Hidden") && <span className="chip chip--muted"> Hidden</span>}
            </dd>
            <dt>Session</dt>
            <dd>
              {photo.sessionId}, shot {photo.shot}
            </dd>
            <dt>Taken</dt>
            <dd>{formatInZone(photo.capturedAt, event.timezone)}</dd>
            <dt>Size</dt>
            <dd>
              {photo.width} × {photo.height}, {Math.round(photo.variantBytes.hd / 1000)} KB
            </dd>
          </dl>
          {mine?.note && (
            <p role="status" className="muted">
              {mine.note}
            </p>
          )}
          {mine?.error != null && <ErrorNote error={mine.error} />}
          <div className="actions actions--wrap">
            <button type="button" className="btn btn--secondary" onClick={onPrevious ?? undefined} disabled={!onPrevious}>
              Previous
            </button>
            <button type="button" className="btn btn--secondary" onClick={onNext ?? undefined} disabled={!onNext}>
              Next
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => void toggle()} disabled={busy}>
              {photo.hidden ? "Unhide" : "Hide from guests"}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--caution"
              onClick={() => {
                opener.current = document.activeElement as HTMLElement | null;
                setDeleteFailure(null);
                setConfirming(true);
              }}
              disabled={busy}
            >
              Delete permanently
            </button>
            <button type="button" className="btn btn--primary" data-autofocus onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </Dialog>
      {confirming && (
        <ConfirmDialog
          confirmation={photoDeleteConfirmation(photo, event)}
          busy={busy}
          error={deleteFailure}
          restoreFocus={opener.current}
          onConfirm={() => void destroy()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
