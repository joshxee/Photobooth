import { bodyLimit } from "hono/body-limit";
import { noStore } from "../lib/api";
import { addHealthz, createHostApp } from "../lib/hostApp";
import { serveSpa, serveSpaAssets } from "../lib/spa";
import { adminAuth } from "../middleware/adminAuth";
import { sameOrigin } from "../middleware/sameOrigin";
import { devicesApi } from "./admin/devices";
import { eventsApi } from "./admin/events";

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
adminApp.route("/api/devices", devicesApi);
serveSpaAssets(adminApp, "admin");
adminApp.get("/", serveSpa("admin"));
