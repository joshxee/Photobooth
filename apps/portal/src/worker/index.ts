import { createApp } from "./app";
import { log } from "./lib/log";
import { VERSION } from "./lib/version";

const app = createApp();

export default {
  fetch: app.fetch,

  // Retention and purge land in session 16. Until then the daily trigger only proves it fires.
  async scheduled(controller) {
    log.info({ outcome: "scheduled", cron: controller.cron, version: VERSION });
  },
} satisfies ExportedHandler<Env>;
