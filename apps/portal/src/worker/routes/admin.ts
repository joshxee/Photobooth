import { addHealthz, createHostApp } from "../lib/hostApp";
import { serveSpa, serveSpaAssets } from "../lib/spa";

/** The admin host (`admin.<domain>`, behind Cloudflare Access). Later sessions add the API. */
export const adminApp = createHostApp("admin");

addHealthz(adminApp);
serveSpaAssets(adminApp, "admin");
adminApp.get("/", serveSpa("admin"));
