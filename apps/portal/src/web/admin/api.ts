// The admin API client (DESIGN §8 admin). Cloudflare Access puts its cookie on every request, so
// `fetch` needs nothing but same-origin JSON (the Worker's sameOrigin check). Types only come from
// the shared schemas: nothing from zod is bundled.
import type {
  AdminDevice,
  AdminDeviceList,
  AdminEvent,
  AdminEventList,
  AdminPhoto,
  AdminPhotoList,
  AuditAction,
  AuditList,
  DeviceCodeResponse,
  ErrorCode,
  EventCreateRequest,
  EventUpdateRequest,
  PhotoState,
  Variant,
} from "../../shared/schemas";

/** The action routes, `POST /api/events/{id}/{action}`. */
export type EventActionName = "open" | "close" | "publish" | "suspend" | "rotate-link" | "delete" | "restore";

/**
 * A failed call. `network` covers a fetch that threw and an answer that wasn't the API's JSON:
 * when Access's session lapses the browser is redirected to its login page, which looks the same.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network",
    message: string,
    readonly correlationId: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, "network", "", null);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (res.ok) throw new ApiError(0, "network", "", null);
    throw new ApiError(res.status, res.status >= 500 ? "internal" : "invalid_request", "", null);
  }
  if (!res.ok) {
    const e = (parsed ?? {}) as { code?: ErrorCode; message?: string; correlationId?: string };
    throw new ApiError(res.status, e.code ?? "internal", e.message ?? "", e.correlationId ?? null);
  }
  return parsed as T;
}

export const api = {
  listEvents: () => request<AdminEventList>("GET", "/api/events"),
  getEvent: (id: string) => request<AdminEvent>("GET", `/api/events/${id}`),
  createEvent: (body: EventCreateRequest) => request<AdminEvent>("POST", "/api/events", body),
  updateEvent: (id: string, body: EventUpdateRequest) => request<AdminEvent>("PATCH", `/api/events/${id}`, body),
  eventAction: (id: string, action: EventActionName) => request<AdminEvent>("POST", `/api/events/${id}/${action}`, {}),
  listDevices: () => request<AdminDeviceList>("GET", "/api/devices"),
  createDevice: (name: string) => request<DeviceCodeResponse>("POST", "/api/devices", { name }),
  reissueCode: (id: string) => request<DeviceCodeResponse>("POST", `/api/devices/${id}/code`, {}),
  revokeDevice: (id: string) => request<AdminDevice>("POST", `/api/devices/${id}/revoke`, {}),
  listPhotos: (eventId: string, q: PhotoQuery) => request<AdminPhotoList>("GET", `/api/events/${eventId}/photos${queryString(q)}`),
  hidePhoto: (id: string) => request<AdminPhoto>("POST", `/api/photos/${id}/hide`, {}),
  unhidePhoto: (id: string) => request<AdminPhoto>("POST", `/api/photos/${id}/unhide`, {}),
  deletePhoto: (id: string) => request<{ id: string }>("DELETE", `/api/photos/${id}`, {}),
  listAudit: (q: AuditQuery) => request<AuditList>("GET", `/api/audit${queryString(q)}`),
};

export interface PhotoQuery {
  state?: PhotoState;
  hidden?: boolean;
  cursor?: string | null;
}
export interface AuditQuery {
  event?: string;
  action?: AuditAction;
  cursor?: string | null;
}

/** `?a=1&b=2` for the values that are set; "" when none is. */
function queryString(q: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q) as [string, unknown][]) if (value !== undefined && value !== null) params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The admin's own copy of a photo's variant (any state, never cached). A plain URL: the browser sends the Access cookie. */
export const mediaUrl = (photoId: string, variant: Variant) => `/api/media/${photoId}/${variant}`;

/** Access normally answers before the Worker does; a 401 or 403 from the Worker means the identity isn't allowed. */
export function isNotAuthorised(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

/** A sentence for the admin. The server's own words are used only where it words them for people. */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong.";
  switch (e.code) {
    case "network":
      return "Can't reach the server. Check your connection; if it keeps happening, reload the page to sign in again.";
    case "unauthorized":
      return "You are not signed in. Reload the page to sign in again.";
    case "forbidden":
      return "You are not allowed to do that.";
    case "not_found":
      return "That no longer exists. It may have been deleted; reload the page.";
    case "conflict":
      return e.message || "That isn't possible in its current state; reload and try again.";
    case "rate_limited":
      return "Too many requests. Wait a minute and try again.";
    case "internal":
      return `The server had a problem. Try again in a moment${e.correlationId ? ` (reference ${e.correlationId})` : ""}.`;
    case "too_large":
      return "That request was too large.";
    default:
      return "The server didn't accept that; check the form and try again.";
  }
}
