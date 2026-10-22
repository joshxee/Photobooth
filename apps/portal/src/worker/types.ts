import type { Hono } from "hono";

/** Hono environment shared by every app: the Worker bindings plus per-request variables. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    /** Admin host only: who is acting (admin email, `svc:<client id>`), set by adminAuth. */
    actor: string;
  };
};

export type PortalApp = Hono<AppEnv>;
