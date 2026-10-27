import { describe, expect, it } from "bun:test";
import { type Config, preflight } from "./preflight";

const committed = Bun.JSONC.parse(await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()) as Config;

const DB_ID = "11111111-2222-3333-4444-555555555555";
const AUD = "a".repeat(64);

/** The committed config with real-looking IDs filled in, so each test breaks exactly one thing. */
function ready(): Config {
  const c = structuredClone(committed);
  for (const name of ["staging", "staging-admin", "production"]) c.env[name]!.d1_databases[0]!.database_id = DB_ID;
  c.env["staging-admin"]!.vars.ACCESS_AUD = AUD;
  const prod = c.env.production!;
  prod.routes = [
    { pattern: "photos.knockbox.nz", custom_domain: true },
    { pattern: "admin.knockbox.nz", custom_domain: true },
  ];
  Object.assign(prod.vars, {
    GALLERY_HOST: "photos.knockbox.nz",
    ADMIN_HOST: "admin.knockbox.nz",
    ADMIN_EMAILS: "josh@knockbox.nz",
    ACCESS_TEAM_DOMAIN: "knockbox.cloudflareaccess.com",
    ACCESS_AUD: AUD,
    CONTACT_ADDRESS: "34b Malvern Road, Morningside, Auckland",
    CONTACT_EMAIL: "privacy@knockbox.nz",
  });
  return c;
}

describe("preflight", () => {
  it("passes staging and production once their IDs and values are in", () => {
    expect(preflight(ready(), "staging")).toEqual([]);
    expect(preflight(ready(), "production")).toEqual([]);
  });

  it("refuses the committed production block until SETUP F fills it in", () => {
    const problems = preflight(committed, "production").join("\n");
    expect(problems).toContain("database_id");
    expect(problems).toContain("ACCESS_AUD");
    expect(problems).toContain("hosts must be the real domain");
  });

  it("refuses placeholder IDs, DEV_AUTH and missing contact values", () => {
    const c = ready();
    c.env.staging!.d1_databases[0]!.database_id = "00000000-0000-0000-0000-000000000000";
    c.env.staging!.vars.DEV_AUTH = "1";
    c.env["staging-admin"]!.vars.CONTACT_EMAIL = "";
    expect(preflight(c, "staging")).toEqual([
      "env.staging: the DB binding needs the real database_id",
      "env.staging: DEV_AUTH must be empty",
      "env.staging-admin: CONTACT_ADDRESS and CONTACT_EMAIL must be set",
      "env.staging-admin: must share portal-staging's D1 and R2",
    ]);
  });

  it("keeps the admin out of the gallery Worker, which has no Access in front", () => {
    const c = ready();
    c.env.staging!.vars.ADMIN_HOST = "portal-staging-admin.josh-33c.workers.dev";
    c.env.staging!.vars.ACCESS_AUD = AUD;
    expect(preflight(c, "staging")).toEqual([
      "env.staging: ADMIN_HOST must be a .invalid hostname",
      "env.staging: Access vars must be empty",
    ]);
  });

  it("requires the admin Worker's Access config, its own hostname, the gallery's host, and no cron", () => {
    const c = ready();
    const admin = c.env["staging-admin"]!;
    admin.vars.ACCESS_AUD = "";
    admin.vars.ADMIN_HOST = "portal-staging.josh-33c.workers.dev";
    admin.vars.GALLERY_HOST = "photos.admin.invalid";
    admin.triggers = undefined;
    expect(preflight(c, "staging")).toEqual([
      "env.staging-admin: ADMIN_HOST must be this Worker's workers.dev hostname",
      "env.staging-admin: GALLERY_HOST must be portal-staging's, for the QR links",
      "env.staging-admin: ACCESS_AUD must be the Access application's 64-hex AUD tag",
      // Without its own triggers it inherits the top-level cron.
      "env.staging-admin: crons must be empty (the cron runs on portal-staging)",
    ]);
  });

  it("refuses production on workers.dev, with Preview URLs, extra routes or a service token", () => {
    const c = ready();
    const prod = c.env.production!;
    prod.workers_dev = true;
    prod.preview_urls = true;
    prod.routes!.push({ pattern: "photos.knockbox.nz/*" });
    prod.vars.ADMIN_SERVICE_CLIENTS = "abc.access";
    expect(preflight(c, "production")).toEqual([
      "env.production: preview_urls must be false",
      "env.production: workers_dev must be false (custom domains only)",
      "env.production: routes must be exactly the two custom domains GALLERY_HOST and ADMIN_HOST",
      "env.production: ADMIN_SERVICE_CLIENTS must be empty in production",
    ]);
  });

  it("refuses an unknown environment", () => {
    expect(preflight(ready(), "local")).toEqual(['unknown environment "local" (staging or production)']);
  });
});
