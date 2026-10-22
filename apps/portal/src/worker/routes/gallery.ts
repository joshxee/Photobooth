import { noStore } from "../lib/api";
import { addHealthz, createHostApp } from "../lib/hostApp";
import { serveSpa, serveSpaAssets } from "../lib/spa";
import { enrolApi } from "./device/enrol";
import { deviceEventsApi } from "./device/events";
import { devicePhotosApi } from "./device/photos";
import { deviceUploadsApi } from "./device/uploads";

/** The guest + device host (`photos.<domain>`). Later sessions add /e/{id}/api/*. */
export const galleryApp = createHostApp("gallery");

addHealthz(galleryApp);
// The device API (DESIGN §8). Enrolment has no auth; every other device route mounts deviceAuth
// on its own router, so a new router has to choose. The upload PUT has none: its signed URL is the
// authorisation (routes/device/uploads.ts).
galleryApp.use("/v1/device/*", noStore());
galleryApp.route("/v1/device/enrol", enrolApi);
galleryApp.route("/v1/device/events", deviceEventsApi);
galleryApp.route("/v1/device/photos", devicePhotosApi);
galleryApp.route("/v1/device/uploads", deviceUploadsApi);
serveSpaAssets(galleryApp, "gallery");
// The gallery SPA owns every GET under /e/ (its own client-side routes included).
galleryApp.get("/e/*", serveSpa("gallery"));
