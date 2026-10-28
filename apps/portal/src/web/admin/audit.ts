// How the Audit view words an audit row (DESIGN §12). Pure. The rows themselves are written by the
// Worker with `detail` that never holds a secret, so this only turns them into sentences.
import { AUDIT_ACTIONS, type AdminDevice, type AdminEvent, type AuditAction, type AuditEntry } from "../../shared/schemas";
import { formatDay } from "./time";

export const ACTION_LABELS: Record<AuditAction, string> = {
  "event.create": "Created an event",
  "event.update": "Edited an event",
  "event.open": "Opened uploads",
  "event.close": "Closed uploads",
  "event.publish": "Published the gallery",
  "event.suspend": "Suspended the gallery",
  "event.rotate_link": "Rotated the gallery link",
  "event.delete": "Deleted an event",
  "event.restore": "Restored an event",
  "event.purge": "Purged a deleted event",
  "device.create": "Created a booth code",
  "device.code": "Re-issued a booth code",
  "device.enrol": "A booth enrolled",
  "device.revoke": "Revoked a booth",
  "photo.hide": "Hid a photo",
  "photo.unhide": "Unhid a photo",
  "photo.delete": "Deleted a photo permanently",
  "audit.prune": "Pruned old audit entries",
};

/** The filter's groups, in order; a test pins that every action is in exactly one. */
export const ACTION_GROUPS: { label: string; actions: AuditAction[] }[] = [
  { label: "Events", actions: AUDIT_ACTIONS.filter((a) => a.startsWith("event.")) },
  { label: "Photos", actions: AUDIT_ACTIONS.filter((a) => a.startsWith("photo.")) },
  { label: "Booths", actions: AUDIT_ACTIONS.filter((a) => a.startsWith("device.")) },
  { label: "Housekeeping", actions: AUDIT_ACTIONS.filter((a) => a.startsWith("audit.")) },
];

export function actionLabel(action: string): string {
  return (ACTION_LABELS as Record<string, string>)[action] ?? action;
}

export function actorLabel(actor: string, devices: ReadonlyMap<string, AdminDevice> = new Map()): string {
  if (actor === "system") return "System (daily job)";
  if (actor.startsWith("svc:")) return `Service token ${actor.slice(4)}`;
  if (actor.startsWith("device:")) return devices.get(actor.slice(7))?.name ?? "A booth";
  return actor;
}

export interface Target {
  text: string;
  /** Where to look at it, when it can still be looked at. */
  to?: string;
}

const detailOf = (e: AuditEntry): Record<string, unknown> => e.detail ?? {};
const textOf = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numberOf = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** What the row was about, with the event's current name when it is still there. */
export function targetOf(e: AuditEntry, events: ReadonlyMap<string, AdminEvent>, devices: ReadonlyMap<string, AdminDevice>): Target {
  const event = e.eventId ? events.get(e.eventId) : undefined;
  const d = detailOf(e);
  if (e.action.startsWith("photo.")) {
    const session = textOf(d.sessionId);
    const shot = numberOf(d.shot);
    const photo = session !== null && shot !== null ? `session ${session}, shot ${shot}` : "a photo";
    return { text: `Photo: ${photo}${event ? ` in ${event.name}` : ""}`, ...(event ? { to: `/events/${event.id}/photos` } : {}) };
  }
  if (e.action.startsWith("event.")) {
    if (event) return { text: event.name, to: `/events/${event.id}` };
    const name = textOf(d.name);
    return { text: name ? `${name} (deleted)` : "An event that no longer exists" };
  }
  if (e.action.startsWith("device.")) {
    const device = e.targetId ? devices.get(e.targetId) : undefined;
    if (device) return { text: device.name, to: "/devices" };
    const name = textOf(d.name);
    return { text: name ?? "A booth that is no longer listed" };
  }
  return { text: "—" };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A short phrase for the row's `detail`; empty when there is nothing worth saying. */
export function detailText(e: AuditEntry): string {
  const d = detailOf(e);
  switch (e.action) {
    case "event.update": {
      const fields = d.fields;
      return Array.isArray(fields) && fields.every((f) => typeof f === "string") && fields.length > 0 ? `Changed ${fields.join(", ")}` : "";
    }
    case "event.rotate_link": {
      const v = numberOf(d.accessVersion);
      return v === null ? "" : `Link version ${v}`;
    }
    case "event.delete": {
      const at = textOf(d.purgeAfter);
      return at ? `Purges ${formatDay(at, "UTC")}` : "";
    }
    case "event.purge": {
      const n = numberOf(d.photos);
      return n === null ? "" : `${plural(n, "photo")} removed`;
    }
    case "audit.prune": {
      const rows = numberOf(d.rows);
      const before = textOf(d.olderThan);
      return rows === null || before === null ? "" : `${rows} ${rows === 1 ? "entry" : "entries"} older than ${formatDay(before, "UTC")}`;
    }
    case "photo.hide":
    case "photo.unhide":
    case "photo.delete": {
      const state = textOf(d.state);
      if (state === null) return "";
      return `Was ${state}${d.hidden === true ? " and hidden" : ""}`;
    }
    default:
      return "";
  }
}
