# 07 — Staging environment and CI deploys

**Goal:** a real staging environment behind Access, deployed only by CI, where agents can
deploy a branch on demand and check the upload path on real R2 and Workers Free (CPU per
request, the metadata rejection). This prepares production without deploying it.

- **Depends on:** 06, and SETUP B–E (business account, domain, Access apps, tokens, GitHub
  environments).
- **Unlocks:** device runs for 10 and 13; 17.
- **Device check:** n/a.
- **Human gate:** you approve the first staging deploy and run the secret commands when asked.

## Read first
- DESIGN.md §4.1 (environments, tokens, service token), §15 (logs, alerts, restore), §16
  (Workers Free is a hard ceiling, shared by staging), §17 (smoke, release gate 3).
- `SETUP.md` (confirm B–E are ticked; if not, stop and ask).
- Cloudflare skill `wrangler`; docs on Wrangler environments and on GitHub Actions with
  `cloudflare/wrangler-action`.

## Scope
1. **Fill in `env.staging`** in `wrangler.jsonc`:
   - Routes for `photos-staging.<domain>` and `admin-staging.<domain>` (custom domains).
   - The D1 database ID and bucket name.
   - Vars: hosts, `ACCESS_TEAM_DOMAIN`, the staging `ACCESS_AUD`, `ADMIN_EMAILS`, the
     `ADMIN_SERVICE_CLIENTS` service-token client ID, and the contact values.
   - Rate-limit namespaces.
   - Behaviour at the Workers Free daily limit (DESIGN §16): routes have a fail-open/closed
     toggle in the dashboard, not in `wrangler.jsonc`. Check in the Cloudflare docs whether it
     applies to Custom Domains (there is no origin behind the Worker). Write down what you find
     and ask the user to set "fail closed" where it applies.
2. **`scripts/provision.ts --env staging|production`:** prints the exact `wrangler` commands to
   create D1 and R2 and set the secrets (there is no lifecycle rule, DESIGN D6). It **prints
   only and never runs them**. You run the staging set now; the production set is SETUP F.
3. **`.github/workflows/deploy-portal.yml`:**
   - `staging` job: runs on push to `main` (paths `apps/portal/**`) and on `workflow_dispatch`
     with a `ref` input, so agents can deploy a branch. Environment `staging`. Steps:
     install → test → build → `wrangler d1 migrations apply --env staging --remote` →
     `wrangler deploy --env staging` → `scripts/smoke.ts` against staging, using the Access
     service token from env secrets.
   - `production` job: `workflow_dispatch` only, with environment `production` and a required
     reviewer. Same steps with `--env production`, apart from smoke against production
     (session 18 decides on a production smoke run). Behind the approval it must also be
     manually dispatched.
   - Both use `cloudflare/wrangler-action`, pin action versions, and never echo secrets.
4. **Smoke against staging:** extend `scripts/smoke.ts` to:
   - use `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers for admin calls;
   - create a uniquely named event and device, enrol, upload the committed synthetic thumb/hd
     pair, and wait for READY;
   - download each variant and check it is byte-identical to what was uploaded;
   - upload a variant carrying GPS EXIF (APP1) and **assert 422 `invalid_image` and no object
     left in R2** (the Worker half of release gate 3 on real R2);
   - clean up by deleting the event.
5. **CPU check:** during the smoke run, capture `wrangler tail --env staging --format json`
   (read-only) and record p95 `cpuTime` for the intent and PUT routes. It must be well under
   the Workers Free 10 ms (the spike measured about 1 ms). Note it in `wiki/Portal.md`.
6. **`AGENTS.md`:**
   - How an agent deploys staging (`gh workflow run deploy-portal.yml -f ref=<branch>`), reads
     staging logs (API MCP with the read-only token, or
     `wrangler tail --env staging` read-only), and calls the staging admin API with the service
     token.
   - Agents never run `wrangler deploy` themselves.

## Out of scope
- Production resources or deploys (18). Per-PR Previews (deferred by DESIGN §4.1).
  Uptime monitoring.

## Verify
```bash
gh workflow run deploy-portal.yml -f ref=portal/07-staging-ci   # then watch the run
curl https://photos-staging.<domain>/healthz
curl https://admin-staging.<domain>/api/events            # without Access → Access login redirect/403
# workers.dev and preview URLs are disabled (check that <worker>.<subdomain>.workers.dev does not serve)
```

## Done when
- [ ] Staging deploys from CI only, and the smoke run is green, including the APP1 rejection
      on real R2.
- [ ] p95 CPU for the intent and PUT routes on staging is recorded and well under 10 ms.
- [ ] The admin host is unreachable without Access, and the alternate hostname is disabled
      (release gate 1, partly).
- [ ] The production job exists but has never run. Provisioning commands are printed for
      SETUP F.

## Hand-off
- `wiki/Portal.md`: the environments and deploy model (why agents hold no write token, why
  there are no Previews yet), the measured CPU per route, the shared daily request limit, and
  the restore runbook from DESIGN §15.
- PROGRESS.md: **note that staging is available for booth device runs (10, 13).**

