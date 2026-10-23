import { type MouseEvent, useEffect, useRef } from "react";
import type { GalleryPhoto, GalleryPhotosPage } from "../../shared/schemas";
import { Icon, Mark } from "../ui/icons";
import { mediaUrl } from "./api";
import { groupSessions, hasHero } from "./feed";
import { formatDate, formatTime, photoCount } from "./format";
import { viewUrl } from "./link";

export type Meta = Pick<GalleryPhotosPage, "eventName" | "localDate" | "eventOpen" | "contact">;

/** A plain click opens in-app; modified clicks (new tab) keep the link's own behaviour. */
function inApp(e: MouseEvent, action: () => void) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  action();
}

function Brand() {
  return (
    <a className="brand icon-btn" href="https://knockbox.nz" aria-label="knockbox studios, knockbox.nz">
      <Mark />
    </a>
  );
}

function Live() {
  return (
    <span className="live">
      <i aria-hidden="true" />
      Live
    </span>
  );
}

interface TileProps {
  publicId: string;
  photo: GalleryPhoto;
  label: string;
  className: string;
  onOpen(photo: GalleryPhoto): void;
}

function Tile({ publicId, photo, label, className, onOpen }: TileProps) {
  return (
    <a className={className} href={mediaUrl(publicId, photo.id, "hd")} aria-label={label} onClick={(e) => inApp(e, () => onOpen(photo))}>
      <img
        className="tile__img"
        src={mediaUrl(publicId, photo.id, "thumb")}
        width={photo.width}
        height={photo.height}
        loading="lazy"
        decoding="async"
        alt=""
      />
    </a>
  );
}

function photoLabel(position: number, total: number, startedAt: string) {
  return `Photo ${position} of ${total}, ${formatTime(startedAt)}`;
}

/** Loads the next page when the button comes near the viewport; the button itself works too. */
function MoreButton({ loading, onMore }: { loading: boolean; onMore(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const latest = useRef(onMore);
  latest.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && latest.current(), {
      rootMargin: "800px 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <button type="button" className="btn btn--secondary more" ref={ref} onClick={onMore} disabled={loading}>
      {loading ? "Loading…" : "Show older photos"}
    </button>
  );
}

interface EventViewProps {
  publicId: string;
  meta: Meta;
  photos: GalleryPhoto[];
  pending: number;
  hasMore: boolean;
  loadingMore: boolean;
  onMore(): void;
  onShowNew(): void;
  onOpen(photo: GalleryPhoto): void;
  onSession(sessionId: string): void;
}

export function EventView(props: EventViewProps) {
  const { publicId, meta, photos, pending } = props;
  const groups = groupSessions(photos);
  return (
    <>
      <header className="top">
        <div className="top__text">
          <h1 tabIndex={-1}>{meta.eventName}</h1>
          <p className="top__meta">
            <span>{formatDate(meta.localDate)}</span>
            {meta.eventOpen && <Live />}
          </p>
        </div>
        <Brand />
      </header>
      <div className="pill-slot" aria-live="polite">
        {pending > 0 && (
          <button type="button" className="pill" onClick={props.onShowNew}>
            <Icon name="up" size={16} />
            {pending === 1 ? "1 new photo" : `${pending} new photos`}
          </button>
        )}
      </div>
      {groups.length === 0 ? (
        <div className="empty">
          <h2>No photos yet</h2>
          <p>{meta.eventOpen ? "Photos show up here a few seconds after each booth session." : "This gallery has no photos."}</p>
        </div>
      ) : (
        groups.map((group) => {
          const hero = hasHero(group.sessionId, group.photos.length);
          const time = formatTime(group.startedAt);
          return (
            <section className="group" key={group.sessionId} aria-label={`Session at ${time}, ${photoCount(group.photos.length)}`}>
              <div className="group__head">
                <h2>
                  <a
                    className="group__link"
                    href={viewUrl(publicId, group.sessionId, null)}
                    onClick={(e) => inApp(e, () => props.onSession(group.sessionId))}
                  >
                    {time}
                    <span className="visually-hidden">, {photoCount(group.photos.length)}, open this session</span>
                    <Icon name="next" size={18} />
                  </a>
                </h2>
                <span className="group__meta">{photoCount(group.photos.length)}</span>
              </div>
              <ul className="tiles" role="list">
                {group.photos.map((photo, i) => (
                  <li key={photo.id} className={hero && i === 0 ? "tiles__hero" : undefined}>
                    <Tile
                      publicId={publicId}
                      photo={photo}
                      className="tile"
                      label={photoLabel(i + 1, group.photos.length, group.startedAt)}
                      onOpen={props.onOpen}
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
      {props.hasMore && <MoreButton loading={props.loadingMore} onMore={props.onMore} />}
    </>
  );
}

interface SessionViewProps {
  publicId: string;
  meta: Meta;
  photos: GalleryPhoto[];
  /** Placeholders: shots expected but not READY yet, or one "more on the way" without a count. */
  waiting: number;
  /** Whether the booth's link said how many shots to expect. */
  countKnown: boolean;
  onOpen(photo: GalleryPhoto): void;
  onEvent(): void;
}

export function SessionView({ publicId, meta, photos, waiting, countKnown, onOpen, onEvent }: SessionViewProps) {
  const shots = [...photos].sort((a, b) => a.shot - b.shot);
  const first = shots[0];
  const total = shots.length + (countKnown ? waiting : 0);
  const status =
    waiting === 0
      ? shots.length > 0
        ? photoCount(shots.length)
        : "None here yet"
      : countKnown
        ? `${shots.length} of ${total} ready`
        : shots.length > 0
          ? `${photoCount(shots.length)} so far, more on the way`
          : "On their way";
  return (
    <>
      <header className="top top--session">
        <div className="top__text">
          <p className="eyebrow">{meta.eventName}</p>
          <h1 tabIndex={-1}>Your photos</h1>
          <p className="top__meta top__meta--lead" role="status">
            {first ? `${formatTime(first.publishedAt)} · ` : ""}
            {status}
          </p>
        </div>
        <Brand />
      </header>
      <ul className="shots" role="list">
        {shots.map((photo, i) => (
          <li key={photo.id}>
            <Tile
              publicId={publicId}
              photo={photo}
              className="shot"
              label={photoLabel(i + 1, Math.max(total, shots.length), first?.publishedAt ?? photo.publishedAt)}
              onOpen={onOpen}
            />
          </li>
        ))}
        {Array.from({ length: waiting }, (_, i) => (
          // Placeholders have no identity; keyed by slot so a filled one is replaced in place.
          <li key={`waiting-${shots.length + i}`}>
            <div className="shot shot--waiting">
              <span>On its way</span>
            </div>
          </li>
        ))}
      </ul>
      <a className="see-all" href={viewUrl(publicId, null, null)} onClick={(e) => inApp(e, onEvent)}>
        <span className="see-all__text">
          <span className="see-all__title">See everyone's photos</span>
          <span className="see-all__sub">{meta.eventOpen ? "Updating live" : "The whole event"}</span>
        </span>
        <Icon name="next" />
      </a>
    </>
  );
}

export function Footer({ meta }: { meta: Meta }) {
  const subject = encodeURIComponent(`Photo removal: ${meta.eventName}`);
  return (
    <footer className="foot">
      <p>
        Only people with this event's link can see these photos. They are kept until the event's gallery is deleted.
      </p>
      <p>
        <a href={`mailto:${meta.contact.email}?subject=${subject}`}>Ask us to remove a photo</a>
      </p>
      <address>
        {meta.contact.address}
        <br />
        <a href={`mailto:${meta.contact.email}`}>{meta.contact.email}</a>
      </address>
      <p className="foot__by">
        Photo booth by <a href="https://knockbox.nz">knockbox.nz</a>
      </p>
    </footer>
  );
}

export function Unavailable() {
  return (
    <main className="calm">
      <Mark size={40} />
      <h1>This gallery isn't available</h1>
      <p>The link may be out of date. Ask the event's host for a new one.</p>
      <p className="calm__by">
        Photo booth by <a href="https://knockbox.nz">knockbox.nz</a>
      </p>
    </main>
  );
}

export function Trouble({ busy, onRetry }: { busy: boolean; onRetry(): void }) {
  return (
    <main className="calm">
      <Mark size={40} />
      <h1>{busy ? "The gallery is busy" : "Can't load the photos"}</h1>
      <p>{busy ? "Trying again in a minute." : "Check your connection, then try again."}</p>
      {!busy && (
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          Try again
        </button>
      )}
    </main>
  );
}

export function Loading() {
  return (
    <main className="page" aria-busy="true">
      <p className="visually-hidden" role="status">
        Loading photos
      </p>
      <div className="tiles tiles--loading" aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="tile tile--loading" />
        ))}
      </div>
    </main>
  );
}
