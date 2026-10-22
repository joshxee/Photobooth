import { createHostApp, type HostKind } from "./lib/hostApp";
import { adminApp } from "./routes/admin";
import { galleryApp } from "./routes/gallery";
import type { PortalApp } from "./types";

const unknownHostApp = createHostApp("unknown");

export interface HostApps {
  gallery: PortalApp;
  admin: PortalApp;
}

/** Which app owns this request's host? Compared lowercase and with the port, as configured. */
export function resolveHost(env: Env, request: Request): HostKind {
  const host = new URL(request.url).host.toLowerCase();
  if (host === env.GALLERY_HOST.toLowerCase()) return "gallery";
  if (host === env.ADMIN_HOST.toLowerCase()) return "admin";
  return "unknown";
}

/**
 * Dispatches on the Host header to the gallery or admin app. An unknown host (including
 * `workers.dev` or a Preview URL, should either ever be enabled) gets a 404 with no routes.
 */
export function createApp(hosts: HostApps = { gallery: galleryApp, admin: adminApp }) {
  return {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
      const kind = resolveHost(env, request);
      const app = kind === "gallery" ? hosts.gallery : kind === "admin" ? hosts.admin : unknownHostApp;
      return app.fetch(request, env, ctx);
    },
  };
}
