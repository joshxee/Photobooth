import type { AdminEvent } from "../../shared/schemas";
import { api } from "./api";
import { useAdmin, useLoad } from "./env";
import { Link } from "./nav";
import { Chip, ErrorNote, Loading } from "./parts";
import { galleryChip, uploadChip } from "./rules";
import { formatDay, formatInZone } from "./time";

export function EventRow({ event, now }: { event: AdminEvent; now: number }) {
  const deleted = event.deletedAt !== null;
  const { ready, pending, rejected, hidden } = event.counts;
  return (
    <tr className={deleted ? "row--deleted" : undefined}>
      <th scope="row">
        <Link to={`/events/${event.id}`}>{event.name}</Link>
        {event.venue && <div className="muted">{event.venue}</div>}
      </th>
      <td>
        {formatInZone(event.startsAt, event.timezone)}
        <div className="muted">{event.timezone}</div>
      </td>
      <td>
        <div className="chips">
          {deleted ? (
            <>
              <span className="chip chip--danger">Deleted</span>
              {event.purgeAfter && <span className="muted">purges {formatDay(event.purgeAfter, event.timezone)}</span>}
            </>
          ) : (
            <>
              <Chip chip={uploadChip(event, now)} />
              <Chip chip={galleryChip(event)} />
            </>
          )}
        </div>
      </td>
      <td className="num">
        <span title="Photos in the gallery">{ready}</span>
        <div className="muted">
          {pending} pending · {rejected} rejected · {hidden} hidden
        </div>
      </td>
    </tr>
  );
}

export function EventsList() {
  const { env } = useAdmin();
  const events = useLoad(() => api.listEvents(), "events");
  const now = env.now();
  return (
    <section>
      <div className="head">
        <h1>Events</h1>
        <Link to="/events/new" className="btn btn--primary">
          New event
        </Link>
      </div>
      {events.loading && <Loading what="events" />}
      {events.error != null && <ErrorNote error={events.error} />}
      {events.data && events.data.events.length === 0 && <p className="muted">No events yet. Create one to get a gallery link and QR code.</p>}
      {events.data && events.data.events.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Starts</th>
                <th scope="col">Status</th>
                <th scope="col">Photos</th>
              </tr>
            </thead>
            <tbody>
              {events.data.events.map((e) => (
                <EventRow key={e.id} event={e} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
