import type { Hono } from "hono";
import type { DeviceRow } from "./db/devices";
import type { EventRow } from "./db/events";
import type { LogFields } from "./lib/log";

/** Hono environment shared by every app: the Worker bindings plus per-request variables. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    /** Admin host only: who is acting (admin email, `svc:<client id>`), set by adminAuth. */
    actor: string;
    /** Device API only: the authenticated device as read before this request, set by deviceAuth. */
    device: DeviceRow;
    /** Guest API only: the event whose gallery the cookie opens, LIVE and not deleted, set by guestAuth. */
    guestEvent: EventRow;
    /** IDs for the access log line (DESIGN §15), added with `addLogIds`; D1 rows read, with `addRowsRead`. */
    logIds: Pick<LogFields, "deviceId" | "eventId" | "photoId" | "rowsRead">;
  };
};

export type PortalApp = Hono<AppEnv>;
