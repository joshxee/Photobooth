// Prints the one-time commands that create an environment's D1 database and R2 bucket and set its
// secrets (session 07, SETUP.md). It PRINTS ONLY and never runs anything: the commands need a write
// login, which agents never hold (AGENTS.md). The owner runs them in PowerShell 7 from apps/portal.
//
//   bun run scripts/provision.ts --env staging      # SETUP D/E, run once (session 07)
//   bun run scripts/provision.ts --env production   # SETUP F (session 18)
//
// Names come from wrangler.jsonc, so they can't drift from what the Workers bind. There is no R2
// lifecycle rule (DESIGN D6: objects stay until an event is deleted). The location hint `oc`
// (Oceania) puts the data near the NZ booths and guests; it is a hint, not a residency guarantee.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface WorkerEnv {
  name: string;
  d1_databases: { database_name: string }[];
  r2_buckets: { bucket_name: string }[];
  secrets?: { required?: string[] };
}

/** The Wrangler environments that make up each deployment environment. */
export const ENVIRONMENTS: Record<string, string[]> = {
  // Interim: two Workers on workers.dev sharing one D1 and R2 (wiki/Portal.md).
  staging: ["staging", "staging-admin"],
  production: ["production"],
};

/** The commands, one per line (comments start with `#`), for one deployment environment. */
export function provisionCommands(config: { env: Record<string, WorkerEnv> }, environment: string, portalDir = "apps/portal"): string[] {
  const envNames = ENVIRONMENTS[environment];
  if (!envNames) throw new Error(`unknown environment "${environment}" (staging or production)`);
  const workers = envNames.map((name) => {
    const env = config.env[name];
    if (!env) throw new Error(`wrangler.jsonc has no env.${name}`);
    return { envName: name, ...env };
  });
  const databases = [...new Set(workers.flatMap((w) => w.d1_databases.map((d) => d.database_name)))];
  const buckets = [...new Set(workers.flatMap((w) => w.r2_buckets.map((b) => b.bucket_name)))];
  const secrets = [...new Set(workers.flatMap((w) => w.secrets?.required ?? []))];
  if (databases.length !== 1 || buckets.length !== 1) {
    throw new Error(`${environment}: expected one D1 database and one R2 bucket, got ${databases.join(", ")} / ${buckets.join(", ")}`);
  }

  const lines = [
    `# Portal ${environment}: run in PowerShell 7. Never paste any output that is a secret into a chat.`,
    "# If `npx wrangler` does nothing (no Node on PATH), prefix each one: fnm exec --using=22.11.0 -- npx wrangler …",
    "# 0. Wrangler reads wrangler.jsonc from the current folder: anywhere else, --env finds nothing.",
    `Set-Location "${portalDir}"`,
    "# 1. A write login for this window only (the machine-wide CLOUDFLARE_API_TOKEN is read-only).",
    "Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue",
    "npx wrangler login",
    "# 2. Resources. Copy the database_id that d1 create prints into wrangler.jsonc (it is not a secret),",
    "#    or tell the agent: it can read it back with the read-only token.",
    `npx wrangler d1 create ${databases[0]} --location oc --no-update-config`,
    `npx wrangler r2 bucket create ${buckets[0]} --location oc --no-update-config`,
    "# 3. Secrets: a fresh random 32-byte value each, piped straight in (never shown, never saved).",
    `#    Every Worker of the environment gets the same value. A Worker that doesn't exist yet is created`,
    "#    empty here, and the deploy replaces it.",
  ];
  for (const secret of secrets) {
    lines.push("$k = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))");
    for (const w of workers) {
      if (w.secrets?.required?.includes(secret)) lines.push(`$k | npx wrangler secret put ${secret} --env ${w.envName}`);
    }
  }
  lines.push("Remove-Variable k");
  lines.push("# 4. Log out, so the write login isn't left cached in ~/.wrangler for any process on this PC");
  lines.push("#    that runs Wrangler without the read-only token (agents never hold a write token).");
  lines.push("npx wrangler logout");
  lines.push("# 5. Close this window, so the read-only CLOUDFLARE_API_TOKEN is back in the next one.");
  return lines;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { env: { type: "string" } } });
  if (!values.env) {
    console.error("usage: bun run scripts/provision.ts --env staging|production");
    process.exit(2);
  }
  const config = Bun.JSONC.parse(await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()) as {
    env: Record<string, WorkerEnv>;
  };
  const portalDir = fileURLToPath(new URL(".", new URL("../wrangler.jsonc", import.meta.url))).replace(/[\\/]$/, "");
  console.log(provisionCommands(config, values.env, portalDir).join("\n"));
}
