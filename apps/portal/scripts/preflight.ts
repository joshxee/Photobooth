// Refuses a deploy whose wrangler.jsonc environment isn't ready (session 07). The deploy workflows
// run it before touching Cloudflare, so placeholder IDs, a missing Access config, DEV_AUTH, or a
// production Worker reachable on workers.dev never get deployed:
//
//   bun run scripts/preflight.ts --env staging | production
//
// Staging and production share one layout (DESIGN §4.1): custom domains only, workers.dev and
// Preview URLs off. Staging also must stay off production's D1 and R2.
import { parseArgs } from "node:util";

interface Route {
  pattern: string;
  custom_domain?: boolean;
}

export interface WorkerEnv {
  name: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  route?: string | Route;
  routes?: Route[];
  observability?: { enabled?: boolean; redact_query_string?: boolean };
  assets?: { run_worker_first?: boolean | string[] };
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

/** The Worker each environment must deploy to: a renamed block could overwrite another one. */
const NAMES: Record<string, string> = { staging: "portal-staging", production: "portal" };

const dbId = (env: WorkerEnv) => env.d1_databases.find((d) => d.binding === "DB")?.database_id;
const bucket = (env: WorkerEnv) => env.r2_buckets.find((b) => b.binding === "MEDIA")?.bucket_name;

/** The settings every deployed Worker needs, whatever its layout. */
function common(config: Config, envName: string, problems: string[]): WorkerEnv {
  const env = config.env[envName];
  if (!env) {
    problems.push(`env.${envName} is missing`);
    return { name: envName, d1_databases: [], r2_buckets: [], vars: {} };
  }
  const p = (msg: string) => problems.push(`env.${envName}: ${msg}`);
  if (env.name !== NAMES[envName]) p(`name must be "${NAMES[envName]}"`);
  // preview_urls, observability and assets are inherited from the top level when an environment
  // doesn't set them, and an environment's own object replaces the top level's whole.
  if ((env.preview_urls ?? config.preview_urls) !== false) p("preview_urls must be false");
  // Upload URLs carry their signature in the query (DESIGN §13).
  if ((env.observability ?? config.observability)?.redact_query_string !== true) p("observability.redact_query_string must be true");
  // Every response, assets included, goes through the host check and the security headers.
  if ((env.assets ?? config.assets)?.run_worker_first !== true) p("assets.run_worker_first must be true");
  const db = env.d1_databases.find((d) => d.binding === "DB");
  if (!db || db.database_id === ZERO_ID) p("the DB binding needs the real database_id");
  if (!env.r2_buckets.some((b) => b.binding === "MEDIA")) p("the MEDIA binding is missing");
  for (const secret of ["UPLOAD_KEY", "SESSION_KEY"]) {
    if (!env.secrets?.required?.includes(secret)) p(`secrets.required must list ${secret}`);
  }
  if (env.vars.DEV_AUTH !== "") p("DEV_AUTH must be empty");
  if (!env.vars.CONTACT_EMAIL) p("CONTACT_EMAIL must be set");
  for (const host of [env.vars.GALLERY_HOST ?? "", env.vars.ADMIN_HOST ?? ""]) {
    if (host === "" || host.includes("localhost") || host.includes(":")) p(`"${host}" is not a deployed hostname`);
  }
  if (env.vars.GALLERY_HOST === env.vars.ADMIN_HOST) p("GALLERY_HOST and ADMIN_HOST must differ");
  return env;
}

/** The admin Worker's Access settings: what adminAuth needs to accept anyone. */
function accessConfigured(env: WorkerEnv, p: (msg: string) => void): void {
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.vars.ACCESS_TEAM_DOMAIN ?? "")) p("ACCESS_TEAM_DOMAIN must be <team>.cloudflareaccess.com");
  if (!/^[0-9a-f]{64}$/.test(env.vars.ACCESS_AUD ?? "")) p("ACCESS_AUD must be the Access application's 64-hex AUD tag");
  if (!env.vars.ADMIN_EMAILS) p("ADMIN_EMAILS must be set");
}

/** The custom-domain layout both environments share: exactly two routes, workers.dev off, Access set. */
function customDomainProblems(config: Config, envName: string, problems: string[]): WorkerEnv {
  const env = common(config, envName, problems);
  const p = (msg: string) => problems.push(`env.${envName}: ${msg}`);
  if ((env.workers_dev ?? config.workers_dev) !== false) p("workers_dev must be false (custom domains only)");
  if (env.route !== undefined) p("use routes, not route");
  const hosts = (env.routes ?? []).filter((r) => r.custom_domain === true).map((r) => r.pattern).sort();
  const expected = [env.vars.GALLERY_HOST, env.vars.ADMIN_HOST].sort();
  if ((env.routes ?? []).length !== 2 || JSON.stringify(hosts) !== JSON.stringify(expected)) {
    p("routes must be exactly the two custom domains GALLERY_HOST and ADMIN_HOST");
  }
  if ([...hosts, ...expected].some((h) => (h ?? "").endsWith(".invalid") || (h ?? "").endsWith(".workers.dev"))) {
    p("hosts must be the real domain");
  }
  accessConfigured(env, p);
  return env;
}

function stagingProblems(config: Config, problems: string[]): void {
  const env = customDomainProblems(config, "staging", problems);
  // Staging never touches production's data.
  const production = config.env.production;
  if (production && (dbId(env) === dbId(production) || bucket(env) === bucket(production))) {
    problems.push("env.staging: must not use production's D1 or R2");
  }
  // ...nor production's hostnames or Access application.
  if (production && [env.vars.GALLERY_HOST, env.vars.ADMIN_HOST].some((h) => h === production.vars.GALLERY_HOST || h === production.vars.ADMIN_HOST)) {
    problems.push("env.staging: must not claim production's hostnames");
  }
  if (production?.vars.ACCESS_AUD && env.vars.ACCESS_AUD === production.vars.ACCESS_AUD) {
    problems.push("env.staging: ACCESS_AUD must be its own Access application's, not production's");
  }
}

function productionProblems(config: Config, problems: string[]): void {
  const env = customDomainProblems(config, "production", problems);
  if (env.vars.ADMIN_SERVICE_CLIENTS) problems.push("env.production: ADMIN_SERVICE_CLIENTS must be empty in production");
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
