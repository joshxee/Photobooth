import type { Hono } from "hono";
import type { DeviceRow } from "./db/devices";

/** Hono environment shared by every app: the Worker bindings plus per-request variables. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    /** Admin host only: who is acting (admin email, `svc:<client id>`), set by adminAuth. */
    actor: string;
    /** Device API only: the authenticated device as read before this request, set by deviceAuth. */
    device: DeviceRow;
  };
};

export type PortalApp = Hono<AppEnv>;
