import { noStore } from "../lib/api";
import { addHealthz, createHostApp } from "../lib/hostApp";
import { serveSpa, serveSpaAssets } from "../lib/spa";
import { enrolApi } from "./device/enrol";
import { deviceEventsApi } from "./device/events";

/** The guest + device host (`photos.<domain>`). Later sessions add /e/{id}/api/*. */
export const galleryApp = createHostApp("gallery");

addHealthz(galleryApp);
// The device API (DESIGN §8). Enrolment has no auth; every other device route mounts deviceAuth
// on its own router, so a new router has to choose (06's upload PUT is authorised by its URL).
galleryApp.use("/v1/device/*", noStore());
galleryApp.route("/v1/device/enrol", enrolApi);
galleryApp.route("/v1/device/events", deviceEventsApi);
serveSpaAssets(galleryApp, "gallery");
// The gallery SPA owns every GET under /e/ (its own client-side routes included).
galleryApp.get("/e/*", serveSpa("gallery"));
