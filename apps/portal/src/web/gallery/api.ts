// The guest API (DESIGN §8, §11). Every refusal is the same 404, so the SPA can only tell
// "available" from "not available", which is all the guest should see (design criterion 5).
import type { GalleryPhotosPage } from "../../shared/schemas";

export type Refusal = { kind: "unavailable" } | { kind: "rate_limited"; retryAfterMs: number } | { kind: "error" };
export type PageResult = { kind: "ok"; page: GalleryPhotosPage } | Refusal;

function refusal(res: Response): Refusal {
  if (res.status === 404) return { kind: "unavailable" };
  if (res.status === 429) {
    const seconds = Number(res.headers.get("Retry-After"));
    return { kind: "rate_limited", retryAfterMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000 };
  }
  return { kind: "error" };
}

/** Swaps the `#k` token for the event cookie. */
export async function swapToken(publicId: string, token: string): Promise<{ kind: "ok" } | Refusal> {
  try {
    const res = await fetch(`/e/${publicId}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token }),
    });
    return res.ok ? { kind: "ok" } : refusal(res);
  } catch {
    return { kind: "error" };
  }
}

/** One page, newest first. No cursor = the first page (what polls read). */
export async function fetchPhotos(publicId: string, opts: { cursor?: string | null; session?: string | null }): Promise<PageResult> {
  const query = new URLSearchParams();
  if (opts.cursor) query.set("cursor", opts.cursor);
  if (opts.session) query.set("session", opts.session);
  const qs = query.toString();
  try {
    const res = await fetch(`/e/${publicId}/api/photos${qs ? `?${qs}` : ""}`, { credentials: "same-origin" });
    if (!res.ok) return refusal(res);
    return { kind: "ok", page: (await res.json()) as GalleryPhotosPage };
  } catch {
    return { kind: "error" };
  }
}

/** Media URLs never change content (immutable caching), so they are never re-requested to refresh. */
export function mediaUrl(publicId: string, photoId: string, variant: "thumb" | "hd", download = false): string {
  return `/e/${publicId}/m/${photoId}/${variant}${download ? "?download=1" : ""}`;
}
