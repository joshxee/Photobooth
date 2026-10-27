// The portal's API contract (DESIGN §8, §9.1, D13): zod schemas for every request and response
// body, with the TypeScript types inferred from them. The Worker validates with these, the SPAs
// import them, and contract/fixtures/*.json pins the device and gallery shapes for the booth's
// serde types (session 09).
//
// Rules for every schema here:
// - Objects are strict: an unknown field fails (DESIGN §8).
// - Strings and arrays have size caps.
// - Response schemas have no transforms or defaults, so parsing a fixture returns it unchanged.
// - Optional fields are omitted when absent, never null. Nullable fields are always present.
// - Times are exactly `Date.toISOString()` form (`2026-10-22T09:30:00.000Z`: UTC, milliseconds),
//   because D1 compares stored times as text and `…00Z` sorts after `…00.500Z`.
import { z } from "zod";

// ---------------------------------------------------------------------------------------
// Limits and errors
// ---------------------------------------------------------------------------------------

/** Decimal bytes, as in the spike (RESULTS.md Q3, Q7). */
export const LIMITS = {
  /** Checked by the intent route, which answers 413 `too_large` (not by the schema). */
  thumbMaxBytes: 200_000,
  hdMaxBytes: 3_000_000,
  /** The thumb's long edge, checked by the header walk (session 06). */
  thumbMaxEdge: 480,
  hdMaxEdge: 2560,
  galleryPageDefault: 24,
  galleryPageMax: 100,
  /** The admin photo grid and audit list pages (session 15); both cap at `galleryPageMax`. */
  adminPhotosDefault: 60,
  auditPageDefault: 50,
  /** `X-Outbox-Depth` is clamped to 0–this before it is stored. */
  outboxDepthMax: 100_000,
} as const;

/** The closed set of error codes. Adding one is a contract change (fixtures + booth mapping). */
export const ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "event_closed",
  "photo_limit",
  "upload_expired",
  "too_large",
  "hash_mismatch",
  "invalid_image",
  "rate_limited",
  "internal",
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The HTTP status that goes with each code (one status per code). */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  event_closed: 409,
  photo_limit: 409,
  upload_expired: 410,
  too_large: 413,
  hash_mismatch: 422,
  invalid_image: 422,
  rate_limited: 429,
  internal: 500,
} as const satisfies Record<ErrorCode, number>;
export type ErrorStatus = (typeof ERROR_STATUS)[ErrorCode];

export const ErrorBody = z.strictObject({
  code: ErrorCode,
  message: z.string().min(1).max(500),
  correlationId: z.uuid(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// ---------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------

/** Lowercase UUID (v1–v8). Row IDs are UUIDv7; clientPhotoId is whatever UUID the booth makes. */
export const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const IsoDateTime = z.iso.datetime({ precision: 3 });
export const LocalDate = z.iso.date();
/** The booth's session ID (`{boot nonce hex}-{n}` today); appears in gallery links as `s=`. */
export const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const Shot = z.int().min(0).max(999);
export const Variant = z.enum(["thumb", "hd"]);
export type Variant = z.infer<typeof Variant>;
export const UploadStatus = z.enum(["DRAFT", "OPEN", "CLOSED"]);
export const GalleryStatus = z.enum(["HIDDEN", "LIVE", "SUSPENDED"]);
export const PhotoState = z.enum(["PENDING", "READY", "REJECTED"]);
const Name = z.string().min(1).max(100);
const Url = z.url({ protocol: /^https?$/ }).max(1024);

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export const TimeZone = z.string().max(64).refine(isTimeZone, "unknown time zone");

// ---------------------------------------------------------------------------------------
// Device API (photos.<domain>, Bearer credential except enrolment)
// ---------------------------------------------------------------------------------------

/**
 * Headers every authenticated device call sends (DESIGN §8): the outbox backlog (an integer,
 * clamped to 0–100000) and the app version (1–32 printable ASCII characters). The server records
 * them, with the time, at most once a minute per device. A missing or malformed value is ignored.
 */
export const DEVICE_HEADERS = { outboxDepth: "X-Outbox-Depth", appVersion: "X-App-Version" } as const;

/** POST /v1/device/enrol. The code is normalised by the route (domain/ids.ts). */
export const EnrolRequest = z.strictObject({
  code: z.string().min(1).max(32),
  name: Name,
  /** Printable ASCII, as `X-App-Version` (DEVICE_HEADERS). */
  appVersion: z.string().regex(/^[\x20-\x7e]{1,32}$/),
});
export type EnrolRequest = z.infer<typeof EnrolRequest>;

/** 201. The credential is shown once and stored server-side only as a hash. */
export const EnrolResponse = z.strictObject({
  deviceId: Id,
  name: Name,
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type EnrolResponse = z.infer<typeof EnrolResponse>;

const deviceEventShape = {
  id: Id,
  name: Name,
  venue: z.string().max(100),
  timezone: TimeZone,
  /** The event's start date in its own time zone, for the booth's picker. */
  localDate: LocalDate,
};

/** GET /v1/device/events: events that accept uploads now. */
export const DeviceEventsResponse = z.strictObject({
  events: z.array(z.strictObject(deviceEventShape)).max(100),
});
export type DeviceEventsResponse = z.infer<typeof DeviceEventsResponse>;

/** GET /v1/device/events/{id}. `galleryUrl` (with `#k=` token) is null unless the gallery is LIVE. */
export const DeviceEventDetail = z.strictObject({
  ...deviceEventShape,
  uploadStatus: UploadStatus,
  galleryStatus: GalleryStatus,
  galleryUrl: Url.nullable(),
});
export type DeviceEventDetail = z.infer<typeof DeviceEventDetail>;

const VariantDeclaration = z.strictObject({
  /** Exact Content-Length of the later PUT. Caps (LIMITS) are enforced by the route. */
  bytes: z.int().min(1).max(2 ** 31 - 1),
  sha256: Sha256Hex,
});

/** POST /v1/device/photos: the upload intent, idempotent on clientPhotoId (DESIGN §9.1). */
export const PhotoIntentRequest = z.strictObject({
  eventId: Id,
  clientPhotoId: Id,
  sessionId: SessionId,
  shot: Shot,
  capturedAt: IsoDateTime,
  /** The HD variant's size, orientation applied. */
  width: z.int().min(1).max(LIMITS.hdMaxEdge),
  height: z.int().min(1).max(LIMITS.hdMaxEdge),
  variants: z.strictObject({ thumb: VariantDeclaration, hd: VariantDeclaration }),
});
export type PhotoIntentRequest = z.infer<typeof PhotoIntentRequest>;

/**
 * Request headers the booth must send with the PUT, exactly as given. Deliberately an open map
 * (the one non-strict object in the contract): DESIGN §9.4 lets the server move to presigned R2
 * URLs, which add headers such as `x-amz-checksum-sha256`, without a booth release. Today it is
 * only `Content-Type: image/jpeg`, which is always required.
 */
export const UploadHeaders = z
  .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().min(1).max(1024))
  .refine((h) => Object.keys(h).length <= 16, "too many headers")
  .refine((h) => h["Content-Type"] === "image/jpeg", "Content-Type must be image/jpeg");

/** Where and how to PUT one variant. The URL is signed and expires (15 min). */
export const UploadDescriptor = z.strictObject({
  method: z.literal("PUT"),
  url: Url,
  headers: UploadHeaders,
  expiresAt: IsoDateTime,
});
export type UploadDescriptor = z.infer<typeof UploadDescriptor>;

/** 200, whatever the state. Errors (409 conflict/event_closed/photo_limit, 413 too_large) use ErrorBody. */
export const PhotoIntentResponse = z.discriminatedUnion("state", [
  /** Both variants stored and published: nothing to upload, delete the local copy. */
  z.strictObject({ state: z.literal("READY"), photoId: Id }),
  /** Upload what is listed: only the variants not yet stored. */
  z.strictObject({
    state: z.literal("PENDING"),
    photoId: Id,
    uploads: z
      .strictObject({ thumb: UploadDescriptor.optional(), hd: UploadDescriptor.optional() })
      .refine((u) => u.thumb !== undefined || u.hd !== undefined, "at least one upload"),
  }),
  /** A variant failed the header check; the booth keeps it and needs attention. */
  z.strictObject({ state: z.literal("REJECTED"), photoId: Id, reason: z.string().min(1).max(200) }),
]);
export type PhotoIntentResponse = z.infer<typeof PhotoIntentResponse>;

/**
 * PUT /v1/device/uploads/{photoId}/{variant}?exp&sig. 201 READY (that was the last variant),
 * 200 STORED (this variant stored, another still pending), 202 PROCESSING (never sent by the
 * MVP; the booth retries it like a 5xx, so an async path needs no app release, DESIGN §9.2).
 */
export const UploadResponse = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("READY"), photoId: Id }),
  z.strictObject({ state: z.literal("STORED"), photoId: Id, variant: Variant }),
  z.strictObject({ state: z.literal("PROCESSING"), photoId: Id }),
]);
export type UploadResponse = z.infer<typeof UploadResponse>;

// ---------------------------------------------------------------------------------------
// Guest gallery API (photos.<domain>/e/{publicId}/api, cookie scoped to the event path)
// ---------------------------------------------------------------------------------------

/** POST /e/{publicId}/api/session: swap the `#k` token for the cookie. */
export const GallerySessionRequest = z.strictObject({ token: z.string().min(1).max(128) });
export type GallerySessionRequest = z.infer<typeof GallerySessionRequest>;

/** 200 with Set-Cookie. Every failure is the same 404. */
export const GallerySessionResponse = z.strictObject({ ok: z.literal(true) });
export type GallerySessionResponse = z.infer<typeof GallerySessionResponse>;

/** GET /e/{publicId}/api/photos query string (strings in, so `limit` is coerced). */
export const GalleryPhotosQuery = z.strictObject({
  cursor: z.string().min(1).max(128).optional(),
  session: SessionId.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.galleryPageMax).default(LIMITS.galleryPageDefault),
});
export type GalleryPhotosQuery = z.infer<typeof GalleryPhotosQuery>;

/** Media is at /e/{publicId}/m/{id}/thumb and …/hd (the SPA builds the paths). */
export const GalleryPhoto = z.strictObject({
  id: Id,
  sessionId: SessionId,
  shot: Shot,
  width: z.int().min(1).max(LIMITS.hdMaxEdge),
  height: z.int().min(1).max(LIMITS.hdMaxEdge),
  publishedAt: IsoDateTime,
});
export type GalleryPhoto = z.infer<typeof GalleryPhoto>;

/** READY, non-hidden photos, newest first. `eventOpen` drives polling (DESIGN §11). */
export const GalleryPhotosPage = z.strictObject({
  eventName: Name,
  localDate: LocalDate,
  eventOpen: z.boolean(),
  photos: z.array(GalleryPhoto).max(LIMITS.galleryPageMax),
  nextCursor: z.string().min(1).max(128).nullable(),
  contact: z.strictObject({ address: z.string().min(1).max(200), email: z.email().max(200) }),
});
export type GalleryPhotosPage = z.infer<typeof GalleryPhotosPage>;

// ---------------------------------------------------------------------------------------
// Admin API (admin.<domain>/api, Access JWT). Not shared with the booth, so no fixtures;
// sessions 04, 05, 14 and 15 may refine these as they build the routes.
// ---------------------------------------------------------------------------------------

const eventFields = {
  name: Name,
  venue: z.string().max(100),
  timezone: TimeZone,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  photoLimit: z.int().min(1).max(10_000),
};

const endsAfterStart = (e: { startsAt?: string; endsAt?: string }) =>
  e.startsAt === undefined || e.endsAt === undefined || Date.parse(e.endsAt) >= Date.parse(e.startsAt);

export const EventCreateRequest = z
  .strictObject({ ...eventFields, venue: eventFields.venue.optional(), photoLimit: eventFields.photoLimit.optional() })
  .refine(endsAfterStart, "endsAt is before startsAt");
export type EventCreateRequest = z.infer<typeof EventCreateRequest>;

/** Statuses change only through the action routes (open, close, publish, …), not here. */
export const EventUpdateRequest = z
  .strictObject(eventFields)
  .partial()
  .refine((e) => Object.keys(e).length > 0, "nothing to update")
  .refine(endsAfterStart, "endsAt is before startsAt");
export type EventUpdateRequest = z.infer<typeof EventUpdateRequest>;

const count = z.int().min(0);

export const AdminEvent = z.strictObject({
  id: Id,
  publicId: z.string().regex(/^[a-z2-7]{16}$/),
  name: Name,
  venue: z.string().max(100),
  timezone: TimeZone,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  uploadStatus: UploadStatus,
  galleryStatus: GalleryStatus,
  accessVersion: z.int().min(1),
  photoLimit: z.int().min(0),
  /** ends_at + 90 days: uploads stop then; the gallery and photos stay. */
  uploadsUntil: IsoDateTime,
  deletedAt: IsoDateTime.nullable(),
  purgeAfter: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** With the `#k=` token, for the event QR (D9). */
  galleryUrl: Url,
  counts: z.strictObject({ pending: count, ready: count, rejected: count, hidden: count }),
});
export type AdminEvent = z.infer<typeof AdminEvent>;

export const AdminEventList = z.strictObject({ events: z.array(AdminEvent).max(1000) });
export type AdminEventList = z.infer<typeof AdminEventList>;

export const DeviceCreateRequest = z.strictObject({ name: Name });
export type DeviceCreateRequest = z.infer<typeof DeviceCreateRequest>;

/** POST /api/devices and /api/devices/{id}/code: the code is shown once. */
export const DeviceCodeResponse = z.strictObject({
  deviceId: Id,
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
  expiresAt: IsoDateTime,
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponse>;

export const AdminDevice = z.strictObject({
  id: Id,
  name: Name,
  enrolledAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  codeExpiresAt: IsoDateTime.nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  lastBacklog: count.nullable(),
  appVersion: z.string().max(32).nullable(),
});
export type AdminDevice = z.infer<typeof AdminDevice>;

export const AdminDeviceList = z.strictObject({ devices: z.array(AdminDevice).max(1000) });
export type AdminDeviceList = z.infer<typeof AdminDeviceList>;

export const AdminPhoto = z.strictObject({
  id: Id,
  eventId: Id,
  deviceId: Id,
  sessionId: SessionId,
  shot: Shot,
  state: PhotoState,
  rejectReason: z.string().max(200).nullable(),
  hidden: z.boolean(),
  width: z.int().min(1),
  height: z.int().min(1),
  variantBytes: z.strictObject({ thumb: count, hd: count }),
  capturedAt: IsoDateTime,
  publishedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type AdminPhoto = z.infer<typeof AdminPhoto>;

export const AdminPhotoList = z.strictObject({
  photos: z.array(AdminPhoto).max(LIMITS.galleryPageMax),
  nextCursor: z.string().min(1).max(128).nullable(),
});
export type AdminPhotoList = z.infer<typeof AdminPhotoList>;

/** GET /api/events/{id}/photos. `hidden=true|false` keeps only hidden or only visible photos. */
export const AdminPhotosQuery = z.strictObject({
  state: PhotoState.optional(),
  hidden: z.enum(["true", "false"]).optional(),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.galleryPageMax).default(LIMITS.adminPhotosDefault),
});
export type AdminPhotosQuery = z.infer<typeof AdminPhotosQuery>;

/**
 * Every action the audit table holds (DESIGN §12), in the order the filter lists them. The Worker
 * writes only these, a test pins that, and the Audit view labels them. `AuditEntry.action` stays
 * a plain string so an older SPA can still show a newer action.
 */
export const AUDIT_ACTIONS = [
  "event.create",
  "event.update",
  "event.open",
  "event.close",
  "event.publish",
  "event.suspend",
  "event.rotate_link",
  "event.delete",
  "event.restore",
  "event.purge",
  "device.create",
  "device.code",
  "device.enrol",
  "device.revoke",
  "photo.hide",
  "photo.unhide",
  "photo.delete",
  "audit.prune",
] as const;
export const AuditAction = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEntry = z.strictObject({
  id: Id,
  at: IsoDateTime,
  actor: z.string().min(1).max(320),
  action: z.string().min(1).max(64),
  eventId: Id.nullable(),
  targetId: z.string().max(64).nullable(),
  detail: z.record(z.string().max(64), z.unknown()).nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** GET /api/audit: newest first, optionally one event's or one action's. */
export const AuditQuery = z.strictObject({
  event: Id.optional(),
  action: AuditAction.optional(),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.galleryPageMax).default(LIMITS.auditPageDefault),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditList = z.strictObject({
  entries: z.array(AuditEntry).max(LIMITS.galleryPageMax),
  nextCursor: z.string().min(1).max(128).nullable(),
});
export type AuditList = z.infer<typeof AuditList>;
