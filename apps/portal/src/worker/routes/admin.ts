import { bodyLimit } from "hono/body-limit";
import { noStore } from "../lib/api";
import { addHealthz, createHostApp } from "../lib/hostApp";
import { serveSpa, serveSpaAssets } from "../lib/spa";
import { adminAuth } from "../middleware/adminAuth";
import { sameOrigin } from "../middleware/sameOrigin";
import { auditApi } from "./admin/audit";
import { devicesApi } from "./admin/devices";
import { eventsApi } from "./admin/events";
import { photosApi } from "./admin/photos";

/** Admin bodies are a few hundred bytes; this only stops a flood from being parsed. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * The admin host (`admin.<domain>`, behind Cloudflare Access). Every request, the SPA shell,
 * assets and /healthz included, needs a verified Access JWT; non-GET requests must also be
 * same-origin JSON. Both run before any route.
 */
export const adminApp = createHostApp("admin");

adminApp.use(adminAuth());
adminApp.use(sameOrigin());

addHealthz(adminApp);
// Admin data is never cached by the browser or anything in between.
adminApp.use("/api/*", bodyLimit({ maxSize: MAX_BODY_BYTES }), noStore());
adminApp.route("/api", eventsApi);
adminApp.route("/api", photosApi);
adminApp.route("/api/devices", devicesApi);
adminApp.route("/api/audit", auditApi);
serveSpaAssets(adminApp, "admin");
// The SPA owns these paths (src/web/admin/nav.tsx), so a reload or bookmark loads the shell.
// Everything else, unknown /api/ paths included, is the JSON 404.
const SPA_VIEWS = /^\/(events(\/new|\/[0-9a-f-]{36}(\/edit|\/photos)?)?|devices|audit)?\/?$/;
adminApp.get("*", (c, next) => (SPA_VIEWS.test(c.req.path) ? serveSpa("admin")(c, next) : c.notFound()));
