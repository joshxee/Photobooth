import { addHealthz, createHostApp } from "../lib/hostApp";
import { serveSpa, serveSpaAssets } from "../lib/spa";

/** The guest + device host (`photos.<domain>`). Later sessions add /v1/device/* and /e/{id}/api/*. */
export const galleryApp = createHostApp("gallery");

addHealthz(galleryApp);
serveSpaAssets(galleryApp, "gallery");
// The gallery SPA owns every GET under /e/ (its own client-side routes included).
galleryApp.get("/e/*", serveSpa("gallery"));
