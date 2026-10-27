// Refuses a deploy whose wrangler.jsonc environment isn't ready (session 07). The deploy workflows
// run it before touching Cloudflare, so placeholder IDs, a missing Access config, DEV_AUTH, or a
// production Worker reachable on workers.dev never get deployed:
//
//   bun run scripts/preflight.ts --env staging | production
//
// Staging is the interim workers.dev layout (wiki/Portal.md → "Interim staging on workers.dev"):
// it checks both of its Workers and that they share one D1 and R2. Production is the design's
// layout (DESIGN §4.1): custom domains only, workers.dev and Preview URLs off.
import { parseArgs } from "node:util";

interface Route {
  pattern: string;
  custom_domain?: boolean;
}

export interface WorkerEnv {
  name: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: Route[];
  triggers?: { crons: string[] };
  d1_databases: { binding: string; database_name: string; database_id: string }[];
  r2_buckets: { binding: string; bucket_name: string }[];
  secrets?: { required?: string[] };
  vars: Record<string, string>;
}

export interface Config extends Omit<WorkerEnv, "name" | "vars"> {
  env: Record<string, WorkerEnv>;
}

const ZERO_ID = "00000000-0000-0000-0000-000000000000";

/** The settings every deployed Worker needs, whatever its layout. */
function common(config: Config, envName: string, problems: string[]): WorkerEnv {
  const env = config.env[envName];
  if (!env) {
    problems.push(`env.${envName} is missing`);
    return { name: envName, d1_databases: [], r2_buckets: [], vars: {} };
  }
  const p = (msg: string) => problems.push(`env.${envName}: ${msg}`);
  // preview_urls is inherited from the top level when an environment doesn't set it.
  if ((env.preview_urls ?? config.preview_urls) !== false) p("preview_urls must be false");
  const db = env.d1_databases.find((d) => d.binding === "DB");
  if (!db || db.database_id === ZERO_ID) p("the DB binding needs the real database_id");
  if (!env.r2_buckets.some((b) => b.binding === "MEDIA")) p("the MEDIA binding is missing");
  for (const secret of ["UPLOAD_KEY", "SESSION_KEY"]) {
    if (!env.secrets?.required?.includes(secret)) p(`secrets.required must list ${secret}`);
  }
  if (env.vars.DEV_AUTH !== "") p("DEV_AUTH must be empty");
  if (!env.vars.CONTACT_ADDRESS || !env.vars.CONTACT_EMAIL) p("CONTACT_ADDRESS and CONTACT_EMAIL must be set");
  for (const host of [env.vars.GALLERY_HOST ?? "", env.vars.ADMIN_HOST ?? ""]) {
    if (host === "" || host.includes("localhost") || host.includes(":")) p(`"${host}" is not a deployed hostname`);
  }
  return env;
}

/** The admin Worker's Access settings: what adminAuth needs to accept anyone. */
function accessConfigured(env: WorkerEnv, p: (msg: string) => void): void {
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.vars.ACCESS_TEAM_DOMAIN ?? "")) p("ACCESS_TEAM_DOMAIN must be <team>.cloudflareaccess.com");
  if (!/^[0-9a-f]{64}$/.test(env.vars.ACCESS_AUD ?? "")) p("ACCESS_AUD must be the Access application's 64-hex AUD tag");
  if (!env.vars.ADMIN_EMAILS) p("ADMIN_EMAILS must be set");
}

function stagingProblems(config: Config, problems: string[]): void {
  const gallery = common(config, "staging", problems);
  const admin = common(config, "staging-admin", problems);
  const pg = (msg: string) => problems.push(`env.staging: ${msg}`);
  const pa = (msg: string) => problems.push(`env.staging-admin: ${msg}`);
  const onWorkersDev = (env: WorkerEnv, host: string | undefined) => (host ?? "").startsWith(`${env.name}.`) && (host ?? "").endsWith(".workers.dev");

  for (const [env, p] of [[gallery, pg], [admin, pa]] as const) {
    if (env.workers_dev !== true) p("workers_dev must be true (interim staging)");
    if ((env.routes ?? []).length > 0) p("no routes until the custom-domain switch");
  }
  if (!onWorkersDev(gallery, gallery.vars.GALLERY_HOST)) pg("GALLERY_HOST must be this Worker's workers.dev hostname");
  // The gallery Worker has no Access in front: its admin host must never resolve, and its Access
  // vars stay empty so adminAuth refuses everything even so.
  if (!(gallery.vars.ADMIN_HOST ?? "").endsWith(".invalid")) pg("ADMIN_HOST must be a .invalid hostname");
  if (gallery.vars.ACCESS_AUD || gallery.vars.ADMIN_EMAILS || gallery.vars.ADMIN_SERVICE_CLIENTS) pg("Access vars must be empty");

  if (!onWorkersDev(admin, admin.vars.ADMIN_HOST)) pa("ADMIN_HOST must be this Worker's workers.dev hostname");
  if (admin.vars.GALLERY_HOST !== gallery.vars.GALLERY_HOST) pa("GALLERY_HOST must be portal-staging's, for the QR links");
  accessConfigured(admin, pa);
  if ((admin.triggers?.crons ?? config.triggers?.crons ?? []).length > 0) pa("crons must be empty (the cron runs on portal-staging)");

  const id = (env: WorkerEnv) => env.d1_databases.find((d) => d.binding === "DB")?.database_id;
  const bucket = (env: WorkerEnv) => env.r2_buckets.find((b) => b.binding === "MEDIA")?.bucket_name;
  if (id(gallery) !== id(admin) || bucket(gallery) !== bucket(admin)) pa("must share portal-staging's D1 and R2");
}

function productionProblems(config: Config, problems: string[]): void {
  const env = common(config, "production", problems);
  const p = (msg: string) => problems.push(`env.production: ${msg}`);
  if ((env.workers_dev ?? config.workers_dev) !== false) p("workers_dev must be false (custom domains only)");
  const hosts = (env.routes ?? []).filter((r) => r.custom_domain === true).map((r) => r.pattern).sort();
  const expected = [env.vars.GALLERY_HOST, env.vars.ADMIN_HOST].sort();
  if ((env.routes ?? []).length !== 2 || JSON.stringify(hosts) !== JSON.stringify(expected)) {
    p("routes must be exactly the two custom domains GALLERY_HOST and ADMIN_HOST");
  }
  if ([...hosts, ...expected].some((h) => (h ?? "").endsWith(".invalid") || (h ?? "").endsWith(".workers.dev"))) {
    p("hosts must be the real domain");
  }
  accessConfigured(env, p);
  if (env.vars.ADMIN_SERVICE_CLIENTS) p("ADMIN_SERVICE_CLIENTS must be empty in production");
}

/** Everything wrong with the environment, or an empty list when it may be deployed. */
export function preflight(config: Config, environment: string): string[] {
  const problems: string[] = [];
  if (environment === "staging") stagingProblems(config, problems);
  else if (environment === "production") productionProblems(config, problems);
  else problems.push(`unknown environment "${environment}" (staging or production)`);
  return problems;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { env: { type: "string" } } });
  const config = Bun.JSONC.parse(await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()) as Config;
  const problems = preflight(config, values.env ?? "");
  if (problems.length > 0) {
    console.error(`preflight: ${values.env} is not ready to deploy:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`preflight: ${values.env} ok`);
}
