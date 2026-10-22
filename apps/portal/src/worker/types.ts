import type { Hono } from "hono";

/** Hono environment shared by every app: the Worker bindings plus per-request variables. */
export type AppEnv = {
  Bindings: Env;
  Variables: { requestId: string };
};

export type PortalApp = Hono<AppEnv>;
