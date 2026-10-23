import { createApp } from "./app";
import { runRetention } from "./jobs/retention";

const app = createApp();

export default {
  fetch: app.fetch,

  // Daily (wrangler.jsonc triggers.crons): purge deleted events past their undo and prune the audit
  // log (session 16, jobs/retention.ts). The run's clock is the trigger's time, so a manual trigger
  // under `wrangler dev` (`/cdn-cgi/handler/scheduled?time=…`) can pick it.
  async scheduled(controller, env) {
    const summary = await runRetention(env, new Date(controller.scheduledTime));
    // A failed event is already logged. Failing the invocation makes it show as an error in
    // Workers Observability; the next run resumes whatever failed.
    if (summary.failures > 0) throw new Error(`retention: ${summary.failures} event(s) failed`);
  },
} satisfies ExportedHandler<Env>;
