import { noStore } from "../lib/api";
import { addHealthz, createHostApp } from "../lib/hostApp";
import { serveSpa, serveSpaAssets } from "../lib/spa";
import { enrolApi } from "./device/enrol";
import { deviceEventsApi } from "./device/events";
import { devicePhotosApi } from "./device/photos";
import { deviceUploadsApi } from "./device/uploads";
import { guestMediaApi } from "./guest/media";
import { guestPhotosApi } from "./guest/photos";
import { guestSessionApi } from "./guest/session";

/** The guest + device host (`photos.<domain>`). */
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
// The guest API (DESIGN §11), under the event's path so its cookie (Path=/e/{publicId}) reaches it.
// The session swap has no auth (the share token is the proof); photos and media mount guestAuth on
// their own routers. Registered before the SPA, and anything else under …/api/ or …/m/ is a 404, so
// the SPA shell never answers for an API or media URL.
galleryApp.use("/e/:publicId/api/*", noStore());
galleryApp.route("/e/:publicId/api/session", guestSessionApi);
galleryApp.route("/e/:publicId/api/photos", guestPhotosApi);
galleryApp.route("/e/:publicId/m", guestMediaApi);
galleryApp.all("/e/:publicId/api/*", (c) => c.notFound());
galleryApp.all("/e/:publicId/m/*", (c) => c.notFound());
serveSpaAssets(galleryApp, "gallery");
// The gallery SPA owns every other GET under /e/ (its own client-side routes included).
galleryApp.get("/e/*", serveSpa("gallery"));
