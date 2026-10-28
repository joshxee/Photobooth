import type { AdminEvent } from "../../shared/schemas";
import { Link } from "./nav";
import { Chip } from "./parts";
import { galleryChip, uploadChip } from "./rules";

/** The event's name and status chips, and the tabs between its details and its photos. */
export function EventHead({ event, now, current }: { event: AdminEvent; now: number; current: "details" | "photos" }) {
  const photos = event.counts.ready + event.counts.pending + event.counts.rejected;
  return (
    <>
      <p>
        <Link to="/">← Events</Link>
      </p>
      <div className="head">
        <h1>{event.name}</h1>
        <div className="chips">
          {event.deletedAt ? (
            <span className="chip chip--danger">Deleted</span>
          ) : (
            <>
              <Chip chip={uploadChip(event, now)} />
              <Chip chip={galleryChip(event)} />
            </>
          )}
        </div>
      </div>
      <div className="tabbar">
        <nav className="tabs" aria-label="Event sections">
          <Link to={`/events/${event.id}`} aria-current={current === "details" ? "page" : undefined}>
            Details
          </Link>
          <Link to={`/events/${event.id}/photos`} aria-current={current === "photos" ? "page" : undefined}>
            Photos ({photos})
          </Link>
        </nav>
        <Link to={`/audit?event=${event.id}`}>Audit log for this event</Link>
      </div>
    </>
  );
}
