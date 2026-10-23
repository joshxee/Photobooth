// POST /e/{publicId}/api/session on the gallery host (DESIGN §11, D9, D10): the gallery SPA swaps
// the link's `#k` share token for the event's cookie. The token never appears in a URL the server
// sees (it travels in the fragment, then in this body).
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { GallerySessionRequest, GallerySessionResponse } from "../../../shared/schemas";
import { getEventByPublicId } from "../../db/events";
import { galleryVisible } from "../../domain/eventState";
import { isPublicId } from "../../domain/ids";
import { ipRateKey } from "../../domain/rateKey";
import { timingSafeEqual } from "../../domain/tokens";
import { errorResponse } from "../../lib/errors";
import { guestCookie, signGuestCookie } from "../../lib/guestCookie";
import { addLogIds, addRowsRead } from "../../middleware/accessLog";
import type { AppEnv } from "../../types";

/** The request is about 40 bytes. */
const MAX_BODY_BYTES = 1024;
/** The limiter's period (wrangler.jsonc, SESSION_LIMITER), sent as Retry-After. */
const LIMIT_PERIOD_SECONDS = 60;

/**
 * Per IP (an IPv6 address by its /64), before anything else. 429 is the one answer that isn't the
 * generic 404: it depends only on the caller's own request rate, so it says nothing about the event.
 */
const sessionRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { success } = await c.env.SESSION_LIMITER.limit({ key: ipRateKey("session", c.req.header("CF-Connecting-IP")) });
  if (success) return next();
  const res = errorResponse(c, "rate_limited", "Too many attempts. Wait a minute and try again.");
  res.headers.set("Retry-After", String(LIMIT_PERIOD_SECONDS));
  return res;
});

/** Every other failure: unknown event, wrong token, gallery not LIVE, deleted, malformed body. */
const refuse = (c: Parameters<typeof errorResponse>[0]) => errorResponse(c, "not_found", "Not found.");

export const guestSessionApi = new Hono<AppEnv>();

guestSessionApi.post("/", sessionRateLimit, bodyLimit({ maxSize: MAX_BODY_BYTES, onError: refuse }), async (c) => {
  const publicId = c.req.param("publicId") ?? "";
  // JSON only: a cross-site page can't send it without a CORS preflight this Worker never answers,
  // so it can't plant another gallery's cookie in a visitor's browser.
  if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return refuse(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return refuse(c);
  }
  const request = GallerySessionRequest.safeParse(body);
  if (!request.success || !isPublicId(publicId)) return refuse(c);

  const { event, rowsRead } = await getEventByPublicId(c.env.DB, publicId);
  addRowsRead(c, rowsRead);
  // Both checks always run, so a wrong token and a suspended gallery take the same path.
  const allowed = event !== null && [timingSafeEqual(event.share_token, request.data.token), galleryVisible(event)].every(Boolean);
  if (!event || !allowed) return refuse(c);

  addLogIds(c, { eventId: event.id });
  const value = await signGuestCookie(c.env.SESSION_KEY, { eventId: event.id, accessVersion: event.access_version }, new Date());
  c.header("Set-Cookie", guestCookie(publicId, value));
  return c.json(GallerySessionResponse.parse({ ok: true }));
});
