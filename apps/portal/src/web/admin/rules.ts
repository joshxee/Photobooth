// What the admin may do to an event, and what it must be told first (DESIGN §12, §15). The
// availability rules mirror the Worker's state machine (worker/domain/eventState.ts) so the UI
// offers only what the API will accept; the Worker stays the authority and answers 409 otherwise.
import type { AdminDevice, AdminEvent } from "../../shared/schemas";
import type { EventActionName } from "./api";
import { relativeTime } from "./time";

export interface Chip {
  label: string;
  tone: "ok" | "warn" | "muted" | "danger";
}

/** An OPEN event past `uploadsUntil` reads as closed, as the booth sees it (DESIGN §8). */
export function uploadChip(e: AdminEvent, nowMs: number): Chip {
  if (e.uploadStatus === "OPEN" && nowMs < Date.parse(e.uploadsUntil)) return { label: "Uploads open", tone: "ok" };
  if (e.uploadStatus === "DRAFT") return { label: "Uploads not open yet", tone: "muted" };
  return { label: "Uploads closed", tone: "muted" };
}

export function galleryChip(e: AdminEvent): Chip {
  if (e.galleryStatus === "LIVE") return { label: "Gallery live", tone: "ok" };
  if (e.galleryStatus === "SUSPENDED") return { label: "Gallery suspended", tone: "warn" };
  return { label: "Gallery hidden", tone: "muted" };
}

/** The actions the event's state allows, in the order the buttons appear. */
export function availableActions(e: AdminEvent, nowMs: number): EventActionName[] {
  if (e.deletedAt !== null) return e.purgeAfter !== null && nowMs >= Date.parse(e.purgeAfter) ? [] : ["restore"];
  const actions: EventActionName[] = [];
  if (e.uploadStatus === "OPEN") actions.push("close");
  else if (nowMs < Date.parse(e.uploadsUntil)) actions.push("open");
  actions.push(e.galleryStatus === "LIVE" ? "suspend" : "publish", "rotate-link", "delete");
  return actions;
}

/** A booth that has not been heard from for this long has a backlog we can't see. */
export const STALE_AFTER_MS = 10 * 60_000;

export interface BacklogReport {
  /** Enrolled booths whose last report was a non-empty queue. */
  queued: { name: string; backlog: number; lastSeenAt: string | null }[];
  /** Enrolled booths whose queue we can't vouch for: never reported, or silent for over 10 minutes. */
  unknown: { name: string; lastSeenAt: string | null }[];
}

/**
 * The runbook's rule: close uploads only when every booth shows a zero backlog (DESIGN §15). A
 * device isn't tied to an event in the data model, so this is every enrolled, unrevoked booth.
 */
export function backlogReport(devices: AdminDevice[], nowMs: number): BacklogReport {
  const report: BacklogReport = { queued: [], unknown: [] };
  for (const d of devices) {
    if (d.enrolledAt === null || d.revokedAt !== null) continue;
    if (d.lastBacklog !== null && d.lastBacklog > 0) report.queued.push({ name: d.name, backlog: d.lastBacklog, lastSeenAt: d.lastSeenAt });
    const stale = d.lastSeenAt === null || nowMs - Date.parse(d.lastSeenAt) > STALE_AFTER_MS;
    if (d.lastBacklog === null || stale) report.unknown.push({ name: d.name, lastSeenAt: d.lastSeenAt });
  }
  return report;
}

export interface Confirmation {
  title: string;
  paragraphs: string[];
  /** Shown prominently above the buttons: the thing the admin should not miss. */
  warning?: string;
  items?: string[];
  confirmLabel: string;
  danger: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The confirmation an action needs, or null for one that doesn't. `backlog` is null when the
 * devices couldn't be read (the close warning says so rather than staying silent).
 */
export function confirmation(action: EventActionName, e: AdminEvent, backlog: BacklogReport | null, nowMs = Date.now()): Confirmation | null {
  switch (action) {
    case "close":
      return closeConfirmation(e, backlog, nowMs);
    case "suspend":
      return {
        title: `Suspend the gallery for ${e.name}?`,
        paragraphs: [
          "Guests see the \"unavailable\" page straight away, and the QR codes guests scan stop working until you publish again.",
          "Suspending is a pause: Publish brings the same link back. To lock out everyone who has the link, Rotate the link instead. Photos a guest has already viewed stay in their own browser either way.",
        ],
        confirmLabel: "Suspend gallery",
        danger: false,
      };
    case "rotate-link":
      return {
        title: `Rotate the gallery link for ${e.name}?`,
        paragraphs: [
          "Every existing link and QR code stops working at once, including any QR code a booth is showing.",
          "Printed signage must be reprinted with the new QR code. Guests who already have the gallery open lose access on their next request.",
        ],
        confirmLabel: "Rotate link",
        danger: true,
      };
    case "delete":
      return {
        title: `Delete ${e.name}?`,
        paragraphs: [
          "The gallery and uploads stop immediately. You can restore the event for 7 days; after that its photos are deleted permanently and can't be recovered.",
        ],
        confirmLabel: "Delete event",
        danger: true,
      };
    default:
      return null;
  }
}

function closeConfirmation(e: AdminEvent, backlog: BacklogReport | null, nowMs: number): Confirmation {
  const base = {
    title: `Close uploads for ${e.name}?`,
    paragraphs: [
      "Booths stop sending new photos to this event. A photo that hasn't started uploading is refused and needs an operator decision on the booth.",
      "You can open uploads again until the upload window ends.",
    ],
    danger: false,
  };
  if (backlog === null) {
    return { ...base, warning: "We couldn't check the booths' queues. Look at the Devices page before closing.", confirmLabel: "Close uploads anyway" };
  }
  const items: string[] = [];
  const warnings: string[] = [];
  if (backlog.queued.length > 0) {
    warnings.push(`${plural(backlog.queued.length, "booth")} still ${backlog.queued.length === 1 ? "has" : "have"} photos waiting to upload.`);
    for (const d of backlog.queued) items.push(`${d.name}: ${d.backlog} waiting to upload (last seen ${relativeTime(d.lastSeenAt, nowMs)})`);
  }
  if (backlog.unknown.length > 0) {
    warnings.push("We can't tell what the other booths have queued, because they haven't reported lately.");
    for (const d of backlog.unknown) items.push(`${d.name}: last seen ${relativeTime(d.lastSeenAt, nowMs)}, so its queue is unknown`);
  }
  if (warnings.length === 0) return { ...base, confirmLabel: "Close uploads" };
  return { ...base, warning: warnings.join(" "), items, confirmLabel: "Close uploads anyway" };
}
