# 02 — Portal scaffold

**Goal:** `apps/portal` exists with a Worker that routes by host and serves two placeholder
SPAs. Security headers, the error shape, logging, the test harness and CI are in place, so every
later portal session only adds behaviour.

- **Depends on:** 01 (go).
- **Unlocks:** 03.
- **Device check:** n/a.

## Read first
- DESIGN.md §4 (architecture, host routing), §4.1 (environments table), §5 (layout and
  dependencies), §13 (headers and CSP rows), §15 (logs), §17 (testing).
- `apps/booth/build.ts`, `apps/booth/package.json`, `apps/booth/tsconfig.json` (copy the
  conventions).
- Cloudflare skill `workers-best-practices`. Docs: Workers Static Assets, the Vitest
  integration, Wrangler configuration (`index.md` variants).

## Scope
1. **`apps/portal/package.json`** with the deps exactly as in DESIGN §5. Scripts: `dev`
   (`wrangler dev`), `build` (`bun run build.ts`, then `wrangler deploy --dry-run`),
   `typecheck`, `test` (`vitest run` for `src/worker`, then `bun test` for `src/web`).
2. **`wrangler.jsonc`:**
   - `compatibility_date` set to today, with `nodejs_compat` only if needed.
   - `workers_dev: false`, `preview_urls: false`.
   - `observability.enabled`.
   - Assets binding `ASSETS` with `run_worker_first: true`.
   - Bindings `DB` (D1), `MEDIA` (R2), `IMAGES`, and the rate-limit bindings (placeholders).
   - Vars `GALLERY_HOST`, `ADMIN_HOST`, `ADMIN_EMAILS`, `ADMIN_SERVICE_CLIENTS`,
     `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `CONTACT_ADDRESS`, `CONTACT_EMAIL`.
   - A cron trigger (daily, 03:00 NZ ≈ `0 14 * * *` UTC, noting the DST drift).
   - `env.staging` and `env.production` blocks with placeholder IDs and hosts (filled in by
     session 07).
   - Local dev uses `localhost` hosts: `photos.localhost:8787` and `admin.localhost:8787`.
3. **Worker skeleton** (`src/worker/`):
   - `index.ts` exporting `fetch` and `scheduled` (the scheduled handler is a no-op that logs).
   - `app.ts`: the Hono app, which dispatches on `Host` to the `gallery` or `admin` sub-apps.
     An unknown host returns 404.
   - `middleware/headers.ts`: CSP, HSTS, nosniff, `Referrer-Policy: no-referrer`,
     `frame-ancestors 'none'`, exactly as DESIGN §13.
   - `middleware/requestId.ts` and `lib/log.ts`: structured JSON logging with the fields in §15.
     It **never** logs query strings, cookies, auth headers or bodies; there is a unit test for
     this.
   - `lib/errors.ts`: `{code, message, correlationId}`, plus a central `onError` that maps zod
     errors to 400 and unknown errors to 500 without leaking details.
   - `GET /healthz` on both hosts: `{ok: true, version}`.
   - SPA serving: the gallery host serves `dist/gallery/index.html` for `/e/*`; the admin host
     serves `dist/admin/index.html` for `/`, with hashed assets under `/assets/`.
4. **`build.ts`:** builds `src/web/gallery/main.tsx` and `src/web/admin/main.tsx` into
   `dist/gallery` and `dist/admin` with Bun.build. Placeholder pages show only a title.
5. **Tests:**
   - `vitest.config.ts` uses the Cloudflare Vitest plugin and points at `wrangler.jsonc`.
   - Tests cover host routing (gallery, admin, unknown → 404), the headers present on every
     response (including errors), error-shape mapping, and logger redaction.
   - A `bun test` smoke test renders each placeholder SPA.
6. **CI:** add a `portal` job to `.github/workflows/ci.yml` (working-directory `apps/portal`):
   install, typecheck, test, build. Use a path filter so booth-only PRs skip it if this is
   simple to do; otherwise always run it.
7. **`AGENTS.md`:** add the portal commands and the local hostnames.

## Out of scope
- D1 schema, auth, any API routes beyond `/healthz`, real UI, deploys.

## Verify
```bash
cd apps/portal
bun install && bun run typecheck && bun run test && bun run build
bunx wrangler dev   # then: curl -H "Host: photos.localhost" localhost:8787/healthz ; same for admin ; unknown host → 404
```

## Done when
- [ ] The global definition of done passes, and the CI `portal` job is green on the PR.
- [ ] Host routing, headers, error shape and log redaction are covered by tests.
- [ ] Both SPAs build and are served on their host.

## Hand-off
- Create `wiki/Portal.md`: why there is one Worker with host routing, why `run_worker_first`
  (every response gets headers and auth), and the local-dev hostnames.
- PROGRESS.md entry.

