import { describe, expect, it } from "bun:test";
import type { GalleryPhoto, GalleryPhotosPage } from "../../shared/schemas";
import { appendOlder, groupSessions, hasHero, mergeLatest, receiveLatest, showPending, startFeed } from "./feed";

let clock = Date.parse("2026-10-22T09:00:00.000Z");
function photo(n: number, sessionId: string, shot: number): GalleryPhoto {
  clock += 1000;
  return {
    id: `019a0b7e-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
    sessionId,
    shot,
    width: 2560,
    height: 1707,
    publishedAt: new Date(clock).toISOString(),
  };
}
function page(photos: GalleryPhoto[], nextCursor: string | null = null): GalleryPhotosPage {
  return {
    eventName: "Smith wedding",
    localDate: "2026-10-22",
    eventOpen: true,
    photos,
    nextCursor,
    contact: { address: "1 Example St", email: "privacy@example.invalid" },
  };
}
const ids = (photos: GalleryPhoto[]) => photos.map((p) => p.id.slice(-2));

describe("feed", () => {
  const a1 = photo(1, "a-1", 1);
  const a2 = photo(2, "a-1", 2);
  const b1 = photo(3, "b-1", 1);
  const b2 = photo(4, "b-1", 2);
  const c1 = photo(5, "c-1", 1);

  it("starts from the first page, newest first, with its cursor", () => {
    const feed = startFeed(page([b2, b1, a2], "cur"));
    expect(ids(feed.photos)).toEqual(["04", "03", "02"]);
    expect(feed.pending).toEqual([]);
    expect(feed.nextCursor).toBe("cur");
  });

  it("appends an older page without duplicates and takes its cursor", () => {
    const feed = appendOlder(startFeed(page([b2, b1, a2], "cur")), page([a2, a1], null));
    expect(ids(feed.photos)).toEqual(["04", "03", "02", "01"]);
    expect(feed.nextCursor).toBeNull();
  });

  it("holds new photos from a poll as pending, never twice", () => {
    let feed = startFeed(page([b1, a2, a1]));
    feed = receiveLatest(feed, page([b2, b1, a2]));
    expect(ids(feed.pending)).toEqual(["04"]);
    feed = receiveLatest(feed, page([c1, b2, b1]));
    expect(ids(feed.pending)).toEqual(["05", "04"]);
    // The same poll answer again adds nothing.
    feed = receiveLatest(feed, page([c1, b2, b1]));
    expect(ids(feed.pending)).toEqual(["05", "04"]);
    // The grid hasn't moved.
    expect(ids(feed.photos)).toEqual(["03", "02", "01"]);
  });

  it("puts pending photos on top when shown, without duplicates", () => {
    let feed = receiveLatest(startFeed(page([b1, a2, a1])), page([c1, b2, b1]));
    feed = showPending(feed);
    expect(ids(feed.photos)).toEqual(["05", "04", "03", "02", "01"]);
    expect(feed.pending).toEqual([]);
    expect(showPending(feed)).toBe(feed);
  });

  it("keeps a cursor-loaded older page from re-adding a pending photo", () => {
    let feed = receiveLatest(startFeed(page([b1], "cur")), page([b2, b1]));
    feed = appendOlder(feed, page([b2, a1]));
    expect(ids(feed.photos)).toEqual(["03", "01"]);
    expect(ids(feed.pending)).toEqual(["04"]);
  });

  it("flags a gap when a whole polled page is new and more follow", () => {
    const start = startFeed(page([a1]));
    expect(receiveLatest(start, page([b2, b1], "more")).gap).toBe(true);
    expect(receiveLatest(start, page([b2, b1, a1], "more")).gap).toBe(false);
    expect(receiveLatest(start, page([b2, b1], null)).gap).toBe(false);
  });

  it("merges a session poll straight into the photos", () => {
    const feed = mergeLatest(startFeed(page([a1])), page([a2, a1]));
    expect(ids(feed.photos)).toEqual(["02", "01"]);
    expect(feed.pending).toEqual([]);
  });
});

describe("groupSessions", () => {
  it("groups consecutive photos by session, shots in order, timed by the first", () => {
    const x1 = photo(10, "x-1", 1);
    const x2 = photo(11, "x-1", 2);
    const y1 = photo(12, "y-1", 1);
    const groups = groupSessions([y1, x2, x1]);
    expect(groups.map((g) => g.sessionId)).toEqual(["y-1", "x-1"]);
    expect(groups[1]?.photos.map((p) => p.shot)).toEqual([1, 2]);
    expect(groups[1]?.startedAt).toBe(x1.publishedAt);
  });

  it("joins a session split across two pages", () => {
    const x1 = photo(20, "x-2", 1);
    const x2 = photo(21, "x-2", 2);
    expect(groupSessions([x2, x1])).toHaveLength(1);
  });
});

describe("hasHero", () => {
  it("is stable per session and needs at least 3 photos", () => {
    const heroes = Array.from({ length: 30 }, (_, i) => hasHero(`boot-${i}`, 3));
    expect(heroes.some(Boolean)).toBe(true);
    expect(heroes.every(Boolean)).toBe(false);
    for (let i = 0; i < 30; i++) {
      expect(hasHero(`boot-${i}`, 3)).toBe(heroes[i] ?? false);
      expect(hasHero(`boot-${i}`, 2)).toBe(false);
    }
  });
});
