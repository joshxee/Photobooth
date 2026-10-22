import { addHealthz, createHostApp } from "../lib/hostApp";
import { serveSpa, serveSpaAssets } from "../lib/spa";
import { adminAuth } from "../middleware/adminAuth";
import { sameOrigin } from "../middleware/sameOrigin";
import { eventsApi } from "./admin/events";

/**
 * The admin host (`admin.<domain>`, behind Cloudflare Access). Every request, the SPA shell,
 * assets and /healthz included, needs a verified Access JWT; non-GET requests must also be
 * same-origin JSON. Both run before any route.
 */
export const adminApp = createHostApp("admin");

adminApp.use(adminAuth());
adminApp.use(sameOrigin());

addHealthz(adminApp);
adminApp.route("/api", eventsApi);
serveSpaAssets(adminApp, "admin");
adminApp.get("/", serveSpa("admin"));
