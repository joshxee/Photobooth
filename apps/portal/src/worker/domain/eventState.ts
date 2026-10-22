// The event state machine (DESIGN §6, §8 admin, §12, §14). Pure: no I/O, `now` is passed in.
//
// - upload_status and gallery_status move independently.
// - "Deleted" = deleted_at is set (soft delete, 7-day undo). A deleted event serves nothing,
//   accepts nothing, and the only action allowed is restore, until purge_after.
// - "Expired" = now ≥ retention_until (ends_at + 90 days). An expired event serves no gallery
//   and accepts no uploads; it can't be opened or published again.
// - "Purge due" = deleted and now ≥ purge_after. Session 16's cron acts on it.

export type UploadStatus = "DRAFT" | "OPEN" | "CLOSED";
export type GalleryStatus = "HIDDEN" | "LIVE" | "SUSPENDED";

/** The columns of an `events` row the state machine reads and writes. */
export interface EventState {
  upload_status: UploadStatus;
  gallery_status: GalleryStatus;
  share_token: string;
  access_version: number;
  retention_until: string;
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
export type TransitionRefusal = "invalid_transition" | "deleted" | "expired" | "purge_due";

export type TransitionResult = { ok: true; next: EventState } | { ok: false; reason: TransitionRefusal };

export const RETENTION_DAYS = 90;
export const UNDO_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function plusDays(at: Date, days: number): string {
  return new Date(at.getTime() + days * DAY_MS).toISOString();
}

/** `retention_until` for an event ending at `endsAt` (ISO). */
export function retentionUntil(endsAt: string): string {
  return plusDays(new Date(endsAt), RETENTION_DAYS);
}

/** `purge_after` for an event deleted at `deletedAt`. */
export function purgeAfter(deletedAt: Date): string {
  return plusDays(deletedAt, UNDO_DAYS);
}

export function isDeleted(e: Pick<EventState, "deleted_at">): boolean {
  return e.deleted_at !== null;
}

export function isExpired(e: Pick<EventState, "retention_until">, now: Date): boolean {
  return now.getTime() >= Date.parse(e.retention_until);
}

export function isPurgeDue(e: Pick<EventState, "deleted_at" | "purge_after">, now: Date): boolean {
  return e.deleted_at !== null && e.purge_after !== null && now.getTime() >= Date.parse(e.purge_after);
}

/** May a booth create a photo intent for this event? (DESIGN §9.1) */
export function acceptsUploads(e: EventState, now: Date): boolean {
  return e.upload_status === "OPEN" && !isDeleted(e) && !isExpired(e, now);
}

/** May a guest see this event's gallery and media? (DESIGN §11) */
export function galleryVisible(e: EventState, now: Date): boolean {
  return e.gallery_status === "LIVE" && !isDeleted(e) && !isExpired(e, now);
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
      if (isExpired(e, now)) return refuse("expired");
      return to({ upload_status: "OPEN" });
    case "close":
      return e.upload_status === "OPEN" ? to({ upload_status: "CLOSED" }) : refuse("invalid_transition");
    case "publish":
      if (e.gallery_status === "LIVE") return refuse("invalid_transition");
      if (isExpired(e, now)) return refuse("expired");
      return to({ gallery_status: "LIVE" });
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
