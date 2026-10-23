// The gallery's photo list as pure state. Polls only ever read the first page (no cursor), so
// new photos are found by diffing IDs; they wait in `pending` behind the "N new" pill and join
// the top of the grid only when the guest asks, so the grid never moves under their thumb.
import type { GalleryPhoto, GalleryPhotosPage } from "../../shared/schemas";

export interface Feed {
  /** Shown, newest first. */
  photos: GalleryPhoto[];
  /** Found by polling, not shown yet, newest first. */
  pending: GalleryPhoto[];
  nextCursor: string | null;
}

function known(feed: Feed): Set<string> {
  return new Set([...feed.photos, ...feed.pending].map((p) => p.id));
}

export function startFeed(page: GalleryPhotosPage): Feed {
  return { photos: page.photos, pending: [], nextCursor: page.nextCursor };
}

export function appendOlder(feed: Feed, page: GalleryPhotosPage): Feed {
  const seen = known(feed);
  return { ...feed, photos: [...feed.photos, ...page.photos.filter((p) => !seen.has(p.id))], nextCursor: page.nextCursor };
}

/** A poll of the event view: new photos wait for the pill. */
export function receiveLatest(feed: Feed, page: GalleryPhotosPage): Feed {
  const seen = known(feed);
  const fresh = page.photos.filter((p) => !seen.has(p.id));
  return fresh.length ? { ...feed, pending: [...fresh, ...feed.pending] } : feed;
}

export function showPending(feed: Feed): Feed {
  return feed.pending.length ? { ...feed, photos: [...feed.pending, ...feed.photos], pending: [] } : feed;
}

/** A poll of the session view: the guest's own shots fill their placeholders straight away. */
export function mergeLatest(feed: Feed, page: GalleryPhotosPage): Feed {
  return showPending(receiveLatest(feed, page));
}

export interface SessionGroup {
  sessionId: string;
  /** Shot order. */
  photos: GalleryPhoto[];
  /** The first shot's publish time. */
  startedAt: string;
}

export function groupSessions(photos: GalleryPhoto[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const bySession = new Map<string, SessionGroup>();
  for (const photo of photos) {
    let group = bySession.get(photo.sessionId);
    if (!group) {
      group = { sessionId: photo.sessionId, photos: [], startedAt: photo.publishedAt };
      bySession.set(photo.sessionId, group);
      groups.push(group);
    }
    group.photos.push(photo);
    if (photo.publishedAt < group.startedAt) group.startedAt = photo.publishedAt;
  }
  for (const group of groups) group.photos.sort((a, b) => a.shot - b.shot);
  return groups;
}

/** About one session in three shows its first shot large (2 × 2); the same one on every visit. */
export function hasHero(sessionId: string, count: number): boolean {
  if (count < 3) return false;
  let hash = 0;
  for (const ch of sessionId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 3 === 0;
}
