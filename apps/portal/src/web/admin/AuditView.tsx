// The Audit view (DESIGN §12): who did what to which thing and when, newest first, filterable by
// event and action. Read-only. Event and booth names come from the lists the admin already has; a
// purged event is named from what its audit row recorded.
import { useMemo, useState } from "react";
import type { AdminDevice, AdminEvent, AuditAction, AuditEntry } from "../../shared/schemas";
import { api } from "./api";
import { ACTION_GROUPS, ACTION_LABELS, actionLabel, actorLabel, detailText, targetOf } from "./audit";
import { useAdmin, useLoad } from "./env";
import { Link } from "./nav";
import { type Page, usePaged } from "./paged";
import { ErrorNote, Loading } from "./parts";
import { formatInZone } from "./time";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `?event=` in the address (the event page links here); anything that isn't an ID is ignored. */
function eventFromAddress(): string {
  const value = new URLSearchParams(location.search).get("event") ?? "";
  return ID.test(value) ? value : "";
}

export function AuditView() {
  const { env } = useAdmin();
  const [eventId, setEventId] = useState(eventFromAddress);
  const [action, setAction] = useState<AuditAction | "">("");
  const events = useLoad(() => api.listEvents(), "audit:events");
  const devices = useLoad(() => api.listDevices(), "audit:devices");
  const list = usePaged<AuditEntry>(
    async (cursor): Promise<Page<AuditEntry>> => {
      const page = await api.listAudit({ event: eventId || undefined, action: action || undefined, cursor });
      return { items: page.entries, next: page.nextCursor };
    },
    `${eventId}:${action}`,
  );

  const eventsById = useMemo(() => new Map<string, AdminEvent>((events.data?.events ?? []).map((e) => [e.id, e])), [events.data]);
  const devicesById = useMemo(() => new Map<string, AdminDevice>((devices.data?.devices ?? []).map((d) => [d.id, d])), [devices.data]);
  const zone = env.zone();
  const known = eventId === "" || eventsById.has(eventId);

  return (
    <section>
      <h1>Audit</h1>
      <p className="muted">
        Every change made in the portal, and what the booths and the daily job did. Entries are kept for 90 days. Times are shown in {zone}.
      </p>

      <div className="filters">
        <div className="field">
          <label htmlFor="audit-event">Event</label>
          <select id="audit-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">All events</option>
            {(events.data?.events ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
            {!known && events.data && <option value={eventId}>An event that no longer exists</option>}
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-action">What happened</label>
          <select id="audit-action" value={action} onChange={(e) => setAction(e.target.value as AuditAction | "")}>
            <option value="">Everything</option>
            {ACTION_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.actions.map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABELS[a]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      {list.loading && <Loading what="the audit log" />}
      {list.error != null && <ErrorNote error={list.error} />}
      {!list.loading && list.error == null && list.items.length === 0 && (
        <p className="muted">{eventId === "" && action === "" ? "No audit entries yet." : "No audit entries match these filters."}</p>
      )}
      {list.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">About</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((entry) => (
                <Row key={entry.id} entry={entry} zone={zone} events={eventsById} devices={devicesById} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.next !== null && (
        <div className="actions actions--wrap">
          <button type="button" className="btn btn--secondary" onClick={() => void list.loadMore()} disabled={list.loadingMore}>
            {list.loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

function Row({ entry, zone, events, devices }: { entry: AuditEntry; zone: string; events: ReadonlyMap<string, AdminEvent>; devices: ReadonlyMap<string, AdminDevice> }) {
  const target = targetOf(entry, events, devices);
  return (
    <tr>
      <td className="num">{formatInZone(entry.at, zone)}</td>
      <td>{actorLabel(entry.actor, devices)}</td>
      <th scope="row">{actionLabel(entry.action)}</th>
      <td>{target.to ? <Link to={target.to}>{target.text}</Link> : target.text}</td>
      <td className="muted">{detailText(entry)}</td>
    </tr>
  );
}
