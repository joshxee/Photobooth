# 04 — Admin authentication and the events API

**Goal:** the admin host authenticates every request with a verified Cloudflare Access JWT and
exposes the full events API with audit records.

- **Depends on:** 03.
- **Unlocks:** 05.
- **Device check:** n/a.

## Read first
- DESIGN.md §8 (admin list), §12 (admin portal: events), §13 (rows for admin impersonation and
  CSRF), §4.1 (the service-token bullet).
- Cloudflare docs: Access → validating JWTs
  (`https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/index.md`).
  Hono docs for the `jwk` middleware.

## Scope
1. **`middleware/adminAuth.ts`:**
   - Read `Cf-Access-Jwt-Assertion` and verify it against
     `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` using Hono `jwk`, with keys cached by
     the middleware.
   - Check `iss` = team domain, `aud` includes `ACCESS_AUD`, and `exp`/`nbf`.
   - Identity:
     - User tokens: `email` must be in `ADMIN_EMAILS` (case-insensitive).
     - Service tokens: `common_name` must be in `ADMIN_SERVICE_CLIENTS`, which is empty in
       production.
   - Never read `Cf-Access-Authenticated-User-Email`.
   - Failure returns 401 or 403 with no detail. The actor (`email` or `svc:<id>`) is set on
     the context for the audit log.
2. **`middleware/sameOrigin.ts`:** for non-GET requests, require `Origin` to equal
   `https://<ADMIN_HOST>` and the content type to be `application/json`. Do not set CORS
   headers.
3. **Routes** (`routes/admin/events.ts`), all under `/api`:
   - list, get, create, update
   - `open`, `close`, `publish`, `suspend`
   - `rotate-link`: new token, `access_version + 1`
   - `delete`: sets `deleted_at` and `purge_after = +7 days`; access stops immediately
   - `restore` (within 7 days)
   - Responses include photo counts by state, the gallery URL (with token), and the date uploads close
     (`uploadsUntil`).
   - Transitions use the domain state machine from 03; an invalid one returns 409 `conflict`.
4. **`lib/audit.ts`:** every mutation writes an audit row (actor, action, event, target, and a
   detail with **no secrets**: rotation records that it happened, not the token). Writes go in
   the same D1 `batch` as the change.
5. **Local dev:** a `DEV_AUTH=1` var, honoured **only** when the host is `*.localhost`, injects
   a fixed admin actor so `wrangler dev` works without Access. A test proves it is ignored on
   other hosts and when unset.
6. **Tests** (Vitest; sign test JWTs with a local key pair and stub the JWKS fetch):
   - valid user → 200
   - email not on the allowlist → 403
   - wrong `aud`, wrong `iss`, expired, unsigned or `alg:none`, a token signed by another
     key → 401
   - service token allowed only when listed
   - cross-origin POST → 403
   - each route's happy path, an invalid transition, and the audit row written
   - rotation invalidates the old token (checked properly in 11; here only the version bump)

## Out of scope
- The admin UI (sessions 14–15), devices (05), photos and moderation routes (15), purge
  execution (16).

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test
bunx wrangler dev --var DEV_AUTH:1   # then create/open/publish an event with curl via the admin.localhost host; check the audit rows in Local Explorer
```

## Done when
- [ ] All the JWT failure cases are tested and rejected.
- [ ] The events lifecycle works end to end locally, and every mutation is audited.
- [ ] `DEV_AUTH` cannot activate outside localhost, and a test proves it.

## Hand-off
- `wiki/Portal.md`: why the JWT is verified in code, why there is an email allowlist variable
  rather than an admins table, the service-token pattern for agents, and the immediate
  revocation story.
- PROGRESS.md entry.

