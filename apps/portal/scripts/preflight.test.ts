import { describe, expect, it } from "bun:test";
import { type Config, preflight } from "./preflight";

const committed = Bun.JSONC.parse(await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()) as Config;

const DB_ID = "11111111-2222-3333-4444-555555555555";
const PROD_DB_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const AUD = "a".repeat(64);
const STAGING_AUD = "b".repeat(64);

/** The committed config with real-looking IDs filled in, so each test breaks exactly one thing. */
function ready(): Config {
  const c = structuredClone(committed);
  c.env.staging!.d1_databases[0]!.database_id = DB_ID;
  c.env.staging!.vars.ACCESS_AUD = STAGING_AUD;
  c.env.production!.d1_databases[0]!.database_id = PROD_DB_ID;
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

  it("passes the committed staging block once its database_id is in", () => {
    const c = structuredClone(committed);
    c.env.staging!.d1_databases[0]!.database_id = DB_ID;
    expect(preflight(c, "staging")).toEqual([]);
  });

  it("refuses placeholder IDs, DEV_AUTH and missing contact values", () => {
    const c = ready();
    c.env.staging!.d1_databases[0]!.database_id = "00000000-0000-0000-0000-000000000000";
    c.env.staging!.vars.DEV_AUTH = "1";
    c.env.staging!.vars.CONTACT_EMAIL = "";
    expect(preflight(c, "staging")).toEqual([
      "env.staging: the DB binding needs the real database_id",
      "env.staging: DEV_AUTH must be empty",
      "env.staging: CONTACT_ADDRESS and CONTACT_EMAIL must be set",
    ]);
  });

  it("refuses staging on workers.dev, with extra routes, or back on its interim hosts", () => {
    const c = ready();
    const staging = c.env.staging!;
    staging.workers_dev = true;
    staging.routes!.push({ pattern: "photos-staging.knockbox.nz/*" });
    expect(preflight(c, "staging")).toEqual([
      "env.staging: workers_dev must be false (custom domains only)",
      "env.staging: routes must be exactly the two custom domains GALLERY_HOST and ADMIN_HOST",
    ]);
    const d = ready();
    d.env.staging!.vars.GALLERY_HOST = "portal-staging.josh-33c.workers.dev";
    d.env.staging!.routes![0]!.pattern = "portal-staging.josh-33c.workers.dev";
    expect(preflight(d, "staging")).toEqual(["env.staging: hosts must be the real domain"]);
  });

  it("refuses staging claiming production's hostnames or Access application, or a singular route", () => {
    const c = ready();
    const staging = c.env.staging!;
    Object.assign(staging.vars, { GALLERY_HOST: "photos.knockbox.nz", ADMIN_HOST: "admin.knockbox.nz" });
    staging.routes = [
      { pattern: "photos.knockbox.nz", custom_domain: true },
      { pattern: "admin.knockbox.nz", custom_domain: true },
    ];
    staging.vars.ACCESS_AUD = AUD;
    expect(preflight(c, "staging")).toEqual([
      "env.staging: must not claim production's hostnames",
      "env.staging: ACCESS_AUD must be its own Access application's, not production's",
    ]);
    const d = ready();
    d.env.staging!.route = "photos-staging.knockbox.nz/*";
    expect(preflight(d, "staging")).toEqual(["env.staging: use routes, not route"]);
  });

  it("requires staging's Access config, and lets it keep the service token", () => {
    const c = ready();
    expect(c.env.staging!.vars.ADMIN_SERVICE_CLIENTS).not.toBe("");
    c.env.staging!.vars.ACCESS_AUD = "";
    c.env.staging!.vars.ADMIN_EMAILS = "";
    expect(preflight(c, "staging")).toEqual([
      "env.staging: ACCESS_AUD must be the Access application's 64-hex AUD tag",
      "env.staging: ADMIN_EMAILS must be set",
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

  it("refuses production inheriting workers.dev from the top level", () => {
    const c = ready();
    c.workers_dev = true;
    delete c.env.production!.workers_dev;
    expect(preflight(c, "production")).toEqual(["env.production: workers_dev must be false (custom domains only)"]);
  });

  it("refuses a renamed Worker, which would overwrite another environment's", () => {
    const c = ready();
    c.env.staging!.name = "portal";
    c.env.production!.name = "portal-staging";
    expect(preflight(c, "staging")).toContain('env.staging: name must be "portal-staging"');
    expect(preflight(c, "production")).toEqual(['env.production: name must be "portal"']);
  });

  it("keeps staging off production's D1 and R2", () => {
    const c = ready();
    c.env.staging!.d1_databases[0]!.database_id = PROD_DB_ID;
    expect(preflight(c, "staging")).toEqual(["env.staging: must not use production's D1 or R2"]);
    const d = ready();
    d.env.staging!.r2_buckets[0]!.bucket_name = "portal-media";
    expect(preflight(d, "staging")).toEqual(["env.staging: must not use production's D1 or R2"]);
  });

  it("refuses an environment that drops the query redaction or the Worker-first assets", () => {
    const c = ready();
    // An environment's own object replaces the top level's whole, so this loses redact_query_string.
    c.env.production!.observability = { enabled: true };
    c.env.production!.assets = { run_worker_first: false };
    expect(preflight(c, "production")).toEqual([
      "env.production: observability.redact_query_string must be true",
      "env.production: assets.run_worker_first must be true",
    ]);
  });

  it("refuses a production admin host equal to the gallery's", () => {
    const e = ready();
    e.env.production!.vars.ADMIN_HOST = "photos.knockbox.nz";
    e.env.production!.routes = [
      { pattern: "photos.knockbox.nz", custom_domain: true },
      { pattern: "photos.knockbox.nz", custom_domain: true },
    ];
    expect(preflight(e, "production")).toEqual(["env.production: GALLERY_HOST and ADMIN_HOST must differ"]);
  });

  it("refuses an unknown environment", () => {
    expect(preflight(ready(), "local")).toEqual(['unknown environment "local" (staging or production)']);
  });
});
