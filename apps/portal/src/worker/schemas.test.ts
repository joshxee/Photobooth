// Boundary tests for the shared schemas. The fixtures (contract.test.ts) cover the happy shapes.
import { describe, expect, it } from "vitest";
import intent from "../../contract/fixtures/device.intent-request.valid.json";
import pendingBoth from "../../contract/fixtures/device.intent-response.pending-both.json";
import {
  ERROR_CODES,
  ERROR_STATUS,
  EventCreateRequest,
  EventUpdateRequest,
  GalleryPhotosQuery,
  LIMITS,
  PhotoIntentRequest,
  PhotoIntentResponse,
} from "../shared/schemas";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("PhotoIntentRequest", () => {
  const variants = intent.variants;

  it("caps the HD long edge at 2560 px, either orientation", () => {
    expect(ok(PhotoIntentRequest, { ...intent, width: 2560, height: 1707 })).toBe(true);
    expect(ok(PhotoIntentRequest, { ...intent, width: 1707, height: 2560 })).toBe(true);
    expect(ok(PhotoIntentRequest, { ...intent, width: 2561 })).toBe(false);
    expect(ok(PhotoIntentRequest, { ...intent, height: 2561 })).toBe(false);
    expect(ok(PhotoIntentRequest, { ...intent, width: 0 })).toBe(false);
  });

  it("requires lowercase hex sha256 and lowercase UUIDs (the unique key compares text)", () => {
    const upper = { ...variants, hd: { ...variants.hd, sha256: variants.hd.sha256.toUpperCase() } };
    expect(ok(PhotoIntentRequest, { ...intent, variants: upper })).toBe(false);
    expect(ok(PhotoIntentRequest, { ...intent, clientPhotoId: intent.clientPhotoId.toUpperCase() })).toBe(false);
  });

  it("requires both variants", () => {
    expect(ok(PhotoIntentRequest, { ...intent, variants: { hd: variants.hd } })).toBe(false);
  });

  it("leaves the byte caps to the route, so the booth gets too_large rather than invalid_request", () => {
    const big = { thumb: { ...variants.thumb, bytes: LIMITS.thumbMaxBytes + 1 }, hd: { ...variants.hd, bytes: LIMITS.hdMaxBytes + 1 } };
    expect(ok(PhotoIntentRequest, { ...intent, variants: big })).toBe(true);
    expect(ok(PhotoIntentRequest, { ...intent, variants: { ...variants, hd: { ...variants.hd, bytes: 0 } } })).toBe(false);
  });

  it("requires a UTC capture time", () => {
    expect(ok(PhotoIntentRequest, { ...intent, capturedAt: "2026-10-22T09:30:00+13:00" })).toBe(false);
    expect(ok(PhotoIntentRequest, { ...intent, capturedAt: "2026-10-22T09:30:00Z" })).toBe(true);
  });

  it("limits sessionId to URL-safe characters", () => {
    expect(ok(PhotoIntentRequest, { ...intent, sessionId: "a/b" })).toBe(false);
    expect(ok(PhotoIntentRequest, { ...intent, sessionId: "x".repeat(65) })).toBe(false);
  });
});

describe("PhotoIntentResponse", () => {
  it("PENDING needs at least one upload", () => {
    expect(ok(PhotoIntentResponse, { ...pendingBoth, uploads: {} })).toBe(false);
  });

  it("an upload is a PUT of image/jpeg", () => {
    const thumb = { ...pendingBoth.uploads.thumb, method: "POST" };
    expect(ok(PhotoIntentResponse, { ...pendingBoth, uploads: { thumb } })).toBe(false);
  });

  it("READY carries no uploads", () => {
    expect(ok(PhotoIntentResponse, { state: "READY", photoId: pendingBoth.photoId, uploads: pendingBoth.uploads })).toBe(false);
  });
});

describe("GalleryPhotosQuery", () => {
  it("defaults the limit to 24 and caps it at 100", () => {
    expect(GalleryPhotosQuery.parse({})).toEqual({ limit: 24 });
    expect(GalleryPhotosQuery.parse({ limit: "100" })).toEqual({ limit: 100 });
    expect(ok(GalleryPhotosQuery, { limit: "101" })).toBe(false);
    expect(ok(GalleryPhotosQuery, { limit: "0" })).toBe(false);
    expect(ok(GalleryPhotosQuery, { limit: "2.5" })).toBe(false);
  });
});

describe("admin event bodies", () => {
  const create = {
    name: "Smith wedding",
    venue: "Hall",
    timezone: "Pacific/Auckland",
    startsAt: "2026-11-01T05:00:00.000Z",
    endsAt: "2026-11-01T11:00:00.000Z",
  };

  it("accepts a valid event and an optional photo limit", () => {
    expect(ok(EventCreateRequest, create)).toBe(true);
    expect(ok(EventCreateRequest, { ...create, photoLimit: 500 })).toBe(true);
  });

  it("rejects an unknown time zone and an end before the start", () => {
    expect(ok(EventCreateRequest, { ...create, timezone: "Mars/Olympus" })).toBe(false);
    expect(ok(EventCreateRequest, { ...create, endsAt: "2026-11-01T04:59:59.999Z" })).toBe(false);
  });

  it("an update needs at least one field", () => {
    expect(ok(EventUpdateRequest, {})).toBe(false);
    expect(ok(EventUpdateRequest, { name: "New name" })).toBe(true);
    expect(ok(EventUpdateRequest, { status: "OPEN" })).toBe(false);
  });
});

describe("error codes", () => {
  it("every code has a status", () => {
    for (const code of ERROR_CODES) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });
});
