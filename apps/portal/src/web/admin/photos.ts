// What the photo grid shows and keeps (DESIGN §12): the filter, the chips on a tile, and which
// photo the viewer lands on after one leaves the list. Pure, so it is tested without a DOM.
import type { AdminPhoto, PhotoState } from "../../shared/schemas";
import type { PhotoQuery } from "./api";
import type { Chip } from "./rules";

export interface PhotoFilter {
  state: "ALL" | PhotoState;
  visibility: "all" | "visible" | "hidden";
}

export const NO_FILTER: PhotoFilter = { state: "ALL", visibility: "all" };

/** The query parameters for the API: only what narrows the list. */
export function filterQuery(f: PhotoFilter): PhotoQuery {
  const q: PhotoQuery = {};
  if (f.state !== "ALL") q.state = f.state;
  if (f.visibility !== "all") q.hidden = f.visibility === "hidden";
  return q;
}

/** Whether a photo still belongs in a list with this filter, after hiding or unhiding it. */
export function matchesFilter(p: AdminPhoto, f: PhotoFilter): boolean {
  if (f.state !== "ALL" && p.state !== f.state) return false;
  if (f.visibility === "hidden") return p.hidden;
  if (f.visibility === "visible") return !p.hidden;
  return true;
}

/** The photo to show when `id` leaves the list: the next, else the previous, else none. */
export function neighbour(ids: string[], id: string): string | null {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

export function photoChips(p: AdminPhoto): Chip[] {
  const chips: Chip[] = [];
  if (p.state === "PENDING") chips.push({ label: "Pending", tone: "warn" });
  if (p.state === "REJECTED") chips.push({ label: `Rejected: ${p.rejectReason ?? "no reason recorded"}`, tone: "danger" });
  if (p.hidden) chips.push({ label: "Hidden", tone: "muted" });
  return chips;
}

/** How the admin and a guest's removal request can name a photo: its session and shot. */
export function photoLabel(p: AdminPhoto): string {
  return `session ${p.sessionId}, shot ${p.shot}`;
}
