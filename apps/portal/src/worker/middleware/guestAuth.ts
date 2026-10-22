// Guest authentication (DESIGN §11, D10). Every guest API and media request under
// /e/{publicId}/ carries the `g` cookie that POST …/api/session set. The cookie's signature and
// expiry are checked first (no D1 read for a forged one), then the event is read by publicId and
// must be the cookie's event, LIVE, not deleted, and still at the cookie's access_version. So a
// rotation, suspension or deletion takes effect on the very next request.
//
// Every refusal is the same 404 (no hint whether the event exists, is suspended, or the cookie is
// stale), and it clears the cookie, so a browser stops sending a dead one.
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getEventByPublicId } from "../db/events";
import { galleryVisible } from "../domain/eventState";
import { isPublicId } from "../domain/ids";
import { errorResponse } from "../lib/errors";
import { clearGuestCookie, GUEST_COOKIE, verifyGuestCookie } from "../lib/guestCookie";
import type { AppEnv } from "../types";
import { addLogIds, addRowsRead } from "./accessLog";

/** Sets `guestEvent` for the route. Mount it on routes whose path has `:publicId`. */
export const guestAuth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const publicId = c.req.param("publicId") ?? "";
    // A malformed publicId can't be an event, and must not reach the cookie's Path attribute.
    if (!isPublicId(publicId)) return errorResponse(c, "not_found", "Not found.");
    const refuse = () => {
      const res = errorResponse(c, "not_found", "Not found.");
      res.headers.append("Set-Cookie", clearGuestCookie(publicId));
      return res;
    };

    const value = getCookie(c, GUEST_COOKIE);
    const grant = value ? await verifyGuestCookie(c.env.SESSION_KEY, value, new Date()) : null;
    if (!grant) return refuse();

    const { event, rowsRead } = await getEventByPublicId(c.env.DB, publicId);
    addRowsRead(c, rowsRead);
    if (!event || event.id !== grant.eventId || !galleryVisible(event) || event.access_version !== grant.accessVersion) {
      return refuse();
    }
    c.set("guestEvent", event);
    addLogIds(c, { eventId: event.id });
    return next();
  });
