// The event state machine (DESIGN §6, §8 admin, §12, §14). Pure: no I/O, `now` is passed in.
//
// - upload_status and gallery_status move independently.
// - "Deleted" = deleted_at is set (soft delete, 7-day undo). A deleted event serves nothing,
//   accepts nothing, and the only action allowed is restore, until purge_after.
// - "Upload window closed" = now ≥ uploads_until (ends_at + 90 days). Uploads stop for good: the
//   event can't be opened again. The gallery is NOT affected: photos are kept and guests can
//   view them until an admin deletes the event (decided 2026-10-22, DESIGN §14). Events run once.
// - "Purge due" = deleted and now ≥ purge_after. Session 16's cron acts on it.

export type UploadStatus = "DRAFT" | "OPEN" | "CLOSED";
export type GalleryStatus = "HIDDEN" | "LIVE" | "SUSPENDED";

/** The columns of an `events` row the state machine reads and writes. */
export interface EventState {
  upload_status: UploadStatus;
  gallery_status: GalleryStatus;
  share_token: string;
  access_version: number;
  uploads_until: string;
  deleted_at: string | null;
  purge_after: string | null;
}

export type EventAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "publish" }
  | { type: "suspend" }
  /** The caller generates the new token (domain/ids.ts) so this stays deterministic. */
  | { type: "rotate"; shareToken: string }
  | { type: "delete" }
  | { type: "restore" };

/** Why an action was refused. Routes map every reason to 409 `conflict`. */
export type TransitionRefusal = "invalid_transition" | "deleted" | "upload_window_closed" | "purge_due";

export type TransitionResult = { ok: true; next: EventState } | { ok: false; reason: TransitionRefusal };

/** Uploads are accepted until this many days after the event ends. */
export const UPLOAD_WINDOW_DAYS = 90;
export const UNDO_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function plusDays(at: Date, days: number): string {
  return new Date(at.getTime() + days * DAY_MS).toISOString();
}

/** `uploads_until` for an event ending at `endsAt` (ISO). Recompute it whenever ends_at changes. */
export function uploadsUntil(endsAt: string): string {
  return plusDays(new Date(endsAt), UPLOAD_WINDOW_DAYS);
}

/** `purge_after` for an event deleted at `deletedAt`. */
export function purgeAfter(deletedAt: Date): string {
  return plusDays(deletedAt, UNDO_DAYS);
}

export function isDeleted(e: Pick<EventState, "deleted_at">): boolean {
  return e.deleted_at !== null;
}

export function uploadWindowClosed(e: Pick<EventState, "uploads_until">, now: Date): boolean {
  return now.getTime() >= Date.parse(e.uploads_until);
}

export function isPurgeDue(e: Pick<EventState, "deleted_at" | "purge_after">, now: Date): boolean {
  return e.deleted_at !== null && e.purge_after !== null && now.getTime() >= Date.parse(e.purge_after);
}

/** An instant's calendar date (`YYYY-MM-DD`) in an IANA time zone: an event's local date. */
export function localDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    new Date(iso),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** May a booth create a photo intent for this event? (DESIGN §9.1) */
export function acceptsUploads(e: EventState, now: Date): boolean {
  return e.upload_status === "OPEN" && !isDeleted(e) && !uploadWindowClosed(e, now);
}

/** May a guest see this event's gallery and media? (DESIGN §11) No time limit in the MVP. */
export function galleryVisible(e: EventState): boolean {
  return e.gallery_status === "LIVE" && !isDeleted(e);
}

export function applyEventAction(e: EventState, action: EventAction, now: Date): TransitionResult {
  const refuse = (reason: TransitionRefusal): TransitionResult => ({ ok: false, reason });
  const to = (patch: Partial<EventState>): TransitionResult => ({ ok: true, next: { ...e, ...patch } });

  if (isDeleted(e)) {
    if (action.type !== "restore") return refuse("deleted");
    if (isPurgeDue(e, now)) return refuse("purge_due");
    return to({ deleted_at: null, purge_after: null });
  }

  switch (action.type) {
    case "open":
      if (e.upload_status === "OPEN") return refuse("invalid_transition");
      if (uploadWindowClosed(e, now)) return refuse("upload_window_closed");
      return to({ upload_status: "OPEN" });
    case "close":
      return e.upload_status === "OPEN" ? to({ upload_status: "CLOSED" }) : refuse("invalid_transition");
    case "publish":
      return e.gallery_status === "LIVE" ? refuse("invalid_transition") : to({ gallery_status: "LIVE" });
    case "suspend":
      return e.gallery_status === "LIVE" ? to({ gallery_status: "SUSPENDED" }) : refuse("invalid_transition");
    case "rotate":
      if (action.shareToken === e.share_token) return refuse("invalid_transition");
      return to({ share_token: action.shareToken, access_version: e.access_version + 1 });
    case "delete":
      return to({ deleted_at: now.toISOString(), purge_after: purgeAfter(now) });
    case "restore":
      return refuse("invalid_transition");
  }
}
