# Portal

The guest web portal: one Cloudflare Worker in `apps/portal`. The behaviour spec is
[portal/DESIGN.md](./portal/DESIGN.md) and the build plan is [portal/README.md](./portal/README.md).
This page records *why* the code is shaped the way it is, and is extended as each session lands.

**Status (sessions 12 and 16):** the scaffold (02), the D1 schema, data layer, domain rules and shared
contract (03), admin authentication (Cloudflare Access JWT, verified in code) and the admin events
API with audit rows (04), devices: the admin devices API, enrolment and the authenticated device
events API (05), and the live-delivery path: the upload intent, the signed per-variant PUT, the JPEG
header walk and `processPhoto()` (06), and the guest API: the token → cookie swap, the photo list
and media (11), the guest gallery SPA (12), and the daily retention job (16). **Nothing here has run on
real Cloudflare or against a real Access application.** It is verified with Vitest in workerd (local
D1 and R2, JWTs signed with a locally generated key), `wrangler dev` with `scripts/smoke.ts`,
`wrangler d1 … --local`, `wrangler deploy --dry-run` and a browser against `wrangler dev` only.

## One Worker, routed by host

The guest/device host (`photos.<domain>`) and the admin host (`admin.<domain>`) are one Worker, and
`app.ts` picks a sub-app from the request's host. The alternative was two Workers. One was chosen because
the two hosts share the D1 and R2 bindings, the schemas and the error and logging code, and one deploy
can't leave them out of step. The cost is that the separation between guest and admin is a
convention rather than a platform boundary, so the rules are:

- An **unknown host gets a 404** from an app with no routes (not even `/healthz`). The Worker
  therefore serves nothing on `workers.dev` or a Preview URL even if one were enabled by mistake. Both
  are also switched off in `wrangler.jsonc`, so Access can't be bypassed through another hostname.
- The two host apps are built from `createHostApp()`, which owns the request ID, security headers,
  access log and error handlers. No route can opt out of them.
- Host names come from the vars `GALLERY_HOST` and `ADMIN_HOST`, so nothing hard-codes a domain
  (DESIGN §4.1). The comparison is lowercase and **includes the port** as written in the var. A trailing dot (`photos.example.com.`) or a different port is a 404, which fails closed.

## `run_worker_first: true`

By default Workers Static Assets answers a request for a file without running the Worker. That would
send assets without the security headers, without the host check, and (from session 04) without
Access/JWT verification. With `run_worker_first: true` every request, assets included, enters the
Worker, which fetches the file through the `ASSETS` binding (`lib/spa.ts`) and adds the headers.

Consequences:
- **Workers Free:** asset requests now count as Worker requests against the 100,000/day account
  limit (DESIGN §16), which they would not otherwise. The bundles are small and `immutable`, so a
  returning guest's browser doesn't ask again. Budget one or two asset requests per first visit.
- `html_handling` and `not_found_handling` are `"none"`: the Worker, not the assets layer, decides what
  is a page and what is a 404, so there are no automatic redirects or fallbacks to fight.
- Both SPAs sit in one `dist/` directory (`dist/gallery`, `dist/admin`) and the host selects the
  prefix. Only `/assets/*` and the SPA's own shell are reachable. The raw `/gallery/index.html`
  path 404s on both hosts.
- The shell (`index.html`) is `no-cache` because it names the current hashed bundles. Bundles under
  `/assets/` are `immutable`.
- The query string is dropped before calling `ASSETS.fetch`, because it can carry the guest's share token.

## Headers (DESIGN §13)

CSP is `default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'`, plus HSTS,
`nosniff` and `Referrer-Policy: no-referrer`. The middleware rebuilds the response before setting
headers, because responses from the assets binding have immutable headers. It runs after `next()`, so it
also covers 404s and the 500 from `onError`. The strict CSP means **no inline scripts or
styles and no external origins**. Bun's HTML build emits external files only, and `build.ts` must keep
doing so. The booth's `build.ts` has a similar fix for inlined fonts, which the gallery session will
need too.

## Errors and logging

- Every error body is `{code, message, correlationId}`. The correlation ID is the request ID, also
  sent as `X-Request-Id`. The Worker always generates the ID and never takes one from the caller.
- **The error codes are a closed set with one status each** (`ERROR_CODES` and `ERROR_STATUS` in
  `src/shared/schemas.ts`). The booth maps on status *and* code, so a code never travels with two
  statuses. Adding a code is a contract change: a fixture, and the booth's mapping (session 09).

  | Code | Status | Booth behaviour (DESIGN §9.3) |
  |---|---|---|
  | `invalid_request` | 400 | Bug: needs attention |
  | `unauthorized` | 401 | Revoked or unknown credential: needs attention. Enrolment: the code was refused |
  | `forbidden` | 403 | Needs attention |
  | `not_found` | 404 | Needs attention (guests get it for every access failure) |
  | `conflict` | 409 | Same `clientPhotoId`, different hashes or event: needs attention |
  | `event_closed` | 409 | Needs attention |
  | `photo_limit` | 409 | Needs attention |
  | `upload_expired` | 410 | Re-POST the intent for fresh URLs |
  | `too_large` | 413 | Encoder bug: needs attention |
  | `hash_mismatch` | 422 | Retry up to 3 times, then needs attention |
  | `invalid_image` | 422 | Header walk failed: needs attention |
  | `rate_limited` | 429 | Back off, honour `Retry-After` |
  | `internal` | 500 | Back off and retry |
- `onError`: `AppError(code, message)` takes its status from the code, zod errors become 400
  `invalid_request`, a Hono `HTTPException` is mapped onto the set by status (401, 403, 404, 413 and
  429 keep theirs; other 4xx become 400 `invalid_request`, 5xx become 500 `internal`), and anything
  else is a 500 `internal`. The zod issues and the original message are **not** returned or logged,
  because they can contain request data. (Session 02 used `internal_error` and `http_error`; 03
  folded them into the set.)
- Logs go through `lib/log.ts`, which writes a JSON line from an **allowlist of fields**. Cookies, auth
  headers, bodies and query strings can't be logged because they have no field, and `path` is cut at
  `?` and `#`. That is stricter than "remember not to log it", which is how those leaks usually happen.
  Tests cover the unit, and a request carrying a secret query string, cookie and bearer token.
- Workers Free keeps logs for 3 days (DESIGN §15). The access log is one line per request;
  successful media reads will need sampling in a later session.

## Environments

The top level of `wrangler.jsonc` is **local development** (localhost hosts, zero UUIDs). `env.staging` and
`env.production` list their own bindings and vars, because Wrangler doesn't inherit bindings or vars
into environments. They hold placeholder IDs and `example.invalid` hosts until session 07.
`bun run build` runs `wrangler deploy --dry-run` for all three, so a typo in any block fails CI. The top level is named `portal-local`, so a bare `wrangler deploy` (without `--env`) can't overwrite the
production Worker `portal`; still, never deploy it, as its hosts are localhost. `worker-configuration.d.ts` (which also types `exports.default` in tests) is generated by
`bun run types` (re-run it after editing `wrangler.jsonc`) and committed, so typecheck needs no Wrangler.

The cron `0 14 * * *` is 14:00 UTC, which is 03:00 NZDT but 02:00 NZST, since cron has no time zone.
The scheduled handler runs the retention job ("Retention and deletion" below).

## Local development

| What | Host |
|---|---|
| Guest/device | `photos.localhost:8787` |
| Admin | `admin.localhost:8787` |

Browsers resolve `*.localhost` to the loopback address. For curl, send the header, with the port:

```bash
curl -H "Host: photos.localhost:8787" http://localhost:8787/healthz
curl -H "Host: admin.localhost:8787"  http://localhost:8787/healthz
curl -H "Host: other.example"         http://localhost:8787/healthz   # 404
```

On the Windows dev PC, Wrangler and Vitest need Node on PATH (`bunx wrangler` silently does nothing
without it): `fnm exec --using=22.11.0 -- bun run test`.

`wrangler dev` needs the `UPLOAD_KEY` secret: `cp .dev.vars.example .dev.vars` once (a local-only
value; `.dev.vars` is git-ignored). It also needs `dist/` (`bun run build.ts`). The upload path's
end-to-end check is `bun run scripts/smoke.ts --base http://localhost:8787` against
`wrangler dev --var DEV_AUTH:1`.

## Tests

- **Worker** (`src/worker/**/*.test.ts`): Vitest with `@cloudflare/vitest-plugin`, inside workerd
  with the real local bindings. `vitest.config.ts` reads `migrations/` and `src/worker/test/setup.ts`
  applies them before each test file; DB tests call `resetDb()` (`test/factories.ts`) first. Local
  D1 runs statements one at a time, so the concurrency tests prove that the SQL is one atomic
  statement (a read-then-write version fails them), not how remote D1 schedules requests. They cover host routing, headers on every kind of response, error
  mapping, logger redaction and the SPA serving rules. SPA serving is tested against a fake `ASSETS`
  binding so the Worker tests don't depend on a previous build. The real `dist/` was checked by hand
  through `wrangler dev` (headers, caching, host separation).
- **SPAs** (`src/web/**`): `bun test` with happy-dom, loaded through `bunfig.toml`. Vitest and
  `bun test` each ignore the other's files (`include` in `vitest.config.ts`, and `bun test src/web scripts`).
  `bun test` also covers `scripts/` (the seed's JPEG encoder); `tsconfig.scripts.json` typechecks them.
- Vitest 4 is used (the plugin supports 4.1+ and 5). There is no Testing Library: the placeholder
  tests need only `createRoot`, and DESIGN §5 doesn't list it.

## Admin authentication (session 04)

`middleware/adminAuth.ts` runs before every route on the admin host: the API, the SPA shell, its
bundles and `/healthz`. `middleware/sameOrigin.ts` runs after it for every request that isn't GET
or HEAD.

- **Why the JWT is verified in code, not left to Access.** Access in front of the hostname is the
  first gate, but it is a dashboard setting: a policy edited by mistake, a hostname or route it
  doesn't cover, or `workers.dev` switched back on would let requests through with nothing in the
  Worker noticing. Verifying `Cf-Access-Jwt-Assertion` against the team's keys
  (`https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`), with `iss` = `https://<ACCESS_TEAM_DOMAIN>`
  and `aud` containing `ACCESS_AUD` (the AUD tag of *this* Access application), means only a token
  Access signed for this application gets in. `exp` is required (Hono checks it only when present),
  `nbf` and `iat` are checked when present, and only RS256 is accepted, so `alg: none`, HS256 and a
  token signed by any other key are refused. Every failure is a 401 or 403 with the generic error
  body and no reason.
- **Hono's verifier, not the `jwk` middleware itself.** `jwk` only reads `Authorization: Bearer …`,
  and Access sends the bare token in its own header, so the middleware calls `verifyWithJwks` (the
  function `jwk` wraps) directly. Same checks, same code (DESIGN §13 says so).
- **The keys are cached per isolate** for 10 minutes. A token whose `kid` isn't cached causes a
  refetch, and every fetch attempt (refresh, unknown `kid` or retry after a failure) happens at most
  once a minute, so a key rotation is picked up quickly (Access rotates every 6 weeks and keeps the
  old key valid for 7 days) and a flood of forged `kid`s or an outage can't become a flood of certs
  fetches. If a refresh fails, keys fetched within the last hour are still used (with a warning
  log), so a certs-endpoint hiccup doesn't lock every admin out; with no keys that recent, or no
  cache at all, the request is refused (fail closed). Concurrent requests on a cold cache each
  fetch once; admin traffic is too low to need coalescing. An unset
  or malformed `ACCESS_TEAM_DOMAIN` (a bare hostname, no scheme) or `ACCESS_AUD` also refuses
  everything, with a warning log.
- **`Cf-Access-Authenticated-User-Email` is never read.** It is a plain header; only the signed
  `email` claim counts.
- **Why an `ADMIN_EMAILS` variable rather than an admins table.** Access already decides who may
  sign in. The allowlist is a second, independent check in the Worker's own config, so a too-broad
  Access policy (say, "any Google account") still doesn't make someone an admin. A table would be a
  third place to keep in step, would need its own admin UI and bootstrap, and a row can't stop
  someone Access lets through any better than a variable can. Two or three admins change rarely,
  and a change is a reviewed config edit plus a deploy. Emails are compared lowercase, and the
  audit actor is the lowercased email.
- **Service tokens (agents on staging).** An Access service token's JWT has no `email`; its
  `common_name` is the token's client ID. It is accepted only when that ID is in
  `ADMIN_SERVICE_CLIENTS` (comma-separated), and the actor is `svc:<client id>`, so an agent's
  changes stand out in the audit log. **The production list is empty**, so no service token is an
  admin there. A token with both an `email` and a `common_name`, or neither, is refused.
- **Immediate revocation.** Removing an email from `ADMIN_EMAILS` (or a client ID from
  `ADMIN_SERVICE_CLIENTS`) takes effect on the first request after the deploy, even for someone
  whose Access session is still valid, because the Worker checks the claim on every request and
  keeps no admin session of its own. Removing a person from the Access policy, or revoking their
  Access session, stops them at the edge as well. Revoking a service token (or an Access session)
  is enforced by Access at the edge: the Worker has no revocation list, so a JWT Access already
  issued stays signature-valid until its `exp`. Take it off the allowlist too for an immediate cut-off.
- **CSRF.** Non-GET requests need `Origin` equal to `https://<ADMIN_HOST>` (or `http://` for a
  local `*.localhost` host) and `Content-Type: application/json`. A cross-site form can't send JSON,
  and a cross-site `fetch` with a JSON body needs a CORS preflight, which never succeeds because the
  Worker sends no CORS headers. This doesn't rely on the Access cookie's `SameSite` setting.
- **`DEV_AUTH` (local development only).** `wrangler dev --var DEV_AUTH:1` injects the fixed actor
  `dev@admin.localhost`, but only when the value is exactly `1` **and** the request's hostname ends
  in `.localhost`. Staging and production set `DEV_AUTH` to empty in `wrangler.jsonc`, and their
  hostnames are never `*.localhost`, so setting it there by mistake still does nothing. Tests cover
  unset and other values, and non-localhost hosts.
- Tests sign tokens with an RSA key pair generated per run (`src/worker/test/access.ts`) and stub
  the certs fetch; `vitest.config.ts` sets fake Access values. No real team domain or AUD is in the
  repo (they arrive as config in session 07).

## Admin events API (session 04)

`routes/admin/events.ts`, under `/api` on the admin host:

| Route | Does |
|---|---|
| `GET /api/events` | Every event, deleted ones included, newest start first (`AdminEventList`) |
| `POST /api/events` | Create: DRAFT, HIDDEN, a new public ID and share token, `uploads_until` = `ends_at` + 90 days. 201 |
| `GET /api/events/{id}` | One event |
| `PATCH /api/events/{id}` | Edit name, venue, time zone, times or photo limit (statuses change only through actions) |
| `POST /api/events/{id}/{action}` | `open`, `close`, `publish`, `suspend`, `rotate-link`, `delete`, `restore` |

- Every response is an `AdminEvent`: the row, the gallery URL with its `#k=` token (the event QR),
  `uploadsUntil`, and photo counts (`pending`, `ready`, `rejected`, plus `hidden`, which counts
  hidden photos of any state). The counts are one grouped query that the `photos_gallery` index
  covers, so it reads one index entry per photo. Admin responses are `Cache-Control: no-store`.
- **Every mutation and its audit row are one `db.batch`.** For an existing event the audit insert
  is conditional on the event still being at the version the route read (`insertAuditIfEventAt`),
  and the update has the same condition (`updateEvent(…, readAt)`), so both apply or neither does.
  If another admin changed the event in between, the request gets 409 `conflict` and **no audit
  row is written for a change that didn't happen**. `updated_at` always moves forward by at least
  1 ms, so two writes in the same millisecond can't both pass the check.
- The audit `detail` never holds a secret: create records the name, update the names of the fields
  sent, rotation the new `accessVersion` (never the token), delete the `purgeAfter` date. The
  actions are `event.create`, `event.update`, `event.open`, `event.close`, `event.publish`,
  `event.suspend`, `event.rotate_link`, `event.delete` and `event.restore`.
- Transitions go through `applyEventAction`, and every refusal is 409 `conflict` with the same
  message. A deleted event refuses everything but `restore` (edits too), and `restore` is refused
  once `purge_after` has passed. An event past `uploads_until` can be published but not opened (D15).
- An update checks `endsAt >= startsAt` on the merged row (400 `invalid_request`), because the
  schema can check it only when both are in the body, and recomputes `uploads_until` when `ends_at`
  changes.
- **Rotation** writes a new 128-bit token and bumps `access_version`. The old link stops working at
  once, and so does every guest cookie, because the cookie carries the version (D10, enforced in
  session 11). Delete sets `deleted_at` and `purge_after` (+7 days); `galleryVisible` and
  `acceptsUploads` treat a deleted event as gone from that moment.
- An unknown or malformed event ID is a 404 (a malformed one can't name an event, so it isn't a
  400). Bodies over 16 KB are 413 `too_large`; invalid JSON and schema failures are 400.

## Devices and enrolment (session 05)

Admin routes (`routes/admin/devices.ts`, under `/api/devices` on the admin host, behind Access and
the same-origin check):

| Route | Does |
|---|---|
| `GET /api/devices` | Every device in creation order (`AdminDeviceList`): name, enrolled, revoked, pending code expiry, last seen, backlog, app version |
| `POST /api/devices` `{name}` | Create; returns `{deviceId, code, expiresAt}` **once** (201) |
| `POST /api/devices/{id}/code` | Re-issue the code: the old one stops working. 409 for a revoked device |
| `POST /api/devices/{id}/revoke` | Revoke now; voids a pending code. 409 if already revoked |

Device routes on the gallery host (`routes/device/`):

| Route | Auth | Does |
|---|---|---|
| `POST /v1/device/enrol` `{code, name, appVersion}` | the code | `{deviceId, name, credential}` (201), the credential once |
| `GET /v1/device/events` | Bearer | Events that accept uploads now: OPEN, not deleted, before `uploads_until`; soonest start first, at most 100 |
| `GET /v1/device/events/{id}` | Bearer | Any event that isn't deleted, with `galleryUrl` (and its `#k=` token) only while the gallery is LIVE |

- **Codes and credentials are stored only as SHA-256.** The code is in the create (or re-issue)
  response and nowhere else, not even the audit row; the credential is in the enrol response only.
  Checked in the local D1 after a `wrangler dev` run, and by the tests.
- **Enrolment is one statement** (`redeemEnrolCode`, an `UPDATE … RETURNING`): the code must match,
  be unexpired and belong to an unrevoked device, and it is cleared in the same statement, so it
  works once even under concurrent requests. The device takes the `name` the booth sends (the
  operator names the tablet there; the admin's name is a placeholder until then) and counts as seen.
  The enrolment's audit row (`device.enrol`, actor `device:<id>`) is in the same batch and finds the
  device by its new credential hash, so a refused code writes nothing.
- **Every refused code gets the same 401** `unauthorized` with the same message: unknown,
  malformed, expired, already used, replaced by a re-issue, or a revoked device's. All but a
  malformed code run the same single statement, so the timing doesn't separate them either; a
  malformed one is refused before the database, which tells a guesser nothing about which codes
  exist. A body that isn't a valid request is a 400, which says nothing about codes. Codes are
  normalised as people type them (case, spaces, dashes, I/L → 1, O → 0).
- **Why 40 bits and a per-IP limit are enough.** A code is 8 Crockford characters (2^40 ≈ 1.1 ×
  10^12), lives 10 minutes and works once, and only a handful are pending at a time (five tablets).
  `ENROL_LIMITER` allows 10 attempts a minute per IP (`enrolRateKey`: an IPv4 address, or an IPv6
  address's /64, since one subscriber can rotate through a whole /64), checked before the body is
  read, and answers 429 `rate_limited` with `Retry-After: 60`. The per-IP limit stops one client
  guessing quickly; **the real bound is the account's request ceiling**, because an attacker with
  many addresses can spread guesses across them. Spending the whole Workers Free allowance
  (100,000 requests a day) on guesses against five live codes gives about a 5 × 10^-7 chance a day;
  on Workers Paid the ceiling is soft, but 10 million guesses still give only about 4.5 × 10^-5.
  Cloudflare's docs advise against IP keys
  because people share addresses; here sharing costs little (a venue's booths enrol once each), and
  there is no better key before a device has a credential. The binding is approximate and counted
  per Cloudflare location, which the arithmetic above doesn't depend on. The local simulation is
  exercised by the tests and by hand (the 11th attempt from one IP got 429).
- **Re-issuing a code to an enrolled device is allowed:** redeeming it replaces the credential, so a
  wiped or reinstalled tablet enrols again as the same device (its history stays), and the old
  credential stops working at that moment. A revoked device can't get a code: create a new device.
- **Credentials don't expire.** A booth is unattended at events, often offline, and an expiry would
  strand it mid-event with no one to re-enrol it. What protects a lost tablet is revocation, which
  takes effect on the device's next request (every request looks the device up; nothing is
  cached), and last seen, which shows a tablet that went quiet. Revocation also covers 06's signed
  upload URLs, because the PUT checks the device.
- **`middleware/deviceAuth.ts`:** `Authorization: Bearer <43 base64url characters>` → SHA-256 →
  `getDeviceByTokenHash`; no match or a revoked device is 401 `unauthorized` with no detail. It sets
  `c.get("device")` for the route. Each device router mounts it itself (`routes/gallery.ts` mounts
  the routers), so enrolment stays open and 06's upload PUT can use its signed URL instead.
- **The heartbeat** (last seen, `X-Outbox-Depth`, `X-App-Version`; `DEVICE_HEADERS` in
  `src/shared/schemas.ts`) is written **at most once a minute per device**. A booth calls the API on
  every shot and every poll, and an admin only needs minute resolution, so this caps D1 writes
  (100,000 a day on Free) at 1,440 per booth per day. The middleware skips the write when the row it
  already read is under a minute old, which costs nothing, and the `UPDATE` repeats the condition so
  two concurrent requests can't both write. A stored time in the future is overwritten, so a clock
  jump can't freeze it. The backlog is an integer clamped to 0–100000; a missing or malformed header
  keeps the stored value (`COALESCE`), and so does a malformed app version (1–32 printable ASCII).
  The heartbeat is written before the route runs, so a request that then fails (an unknown event)
  still counts as a sign of life. Enrolment sets last seen too.
- **The event detail's `uploadStatus` is the effective one:** an OPEN event past `uploads_until`
  reads CLOSED, because its intents would be refused (D15). A CLOSED event's detail is still served,
  so a booth can keep showing its QR; a deleted event is 404. `localDate` is the start date in the
  event's own time zone (`localDate` in `domain/eventState.ts`).
- A device can read any non-deleted event's gallery link if it knows the event ID (only OPEN ones
  are listed). Devices are enrolled by an admin and revocable, and the booth must show the QR, so
  that is accepted.
- **Audit actions:** `device.create` (detail `{name}`), `device.code`, `device.revoke` (by the admin)
  and `device.enrol` (by the device, detail `{name, appVersion}`), each with `target_id` = the
  device and no event. Re-issue and revoke put `insertAuditIfDeviceActive` before the write in one
  batch, so both apply or neither does: revoking twice gives 409 and one audit row, also when two
  admins race.
- All device responses are `Cache-Control: no-store`. The tests check each response against its
  `device.*` fixture field by field (the same keys and JSON types at every depth) as well as with
  the schema.

## Upload and validation (session 06)

The live-delivery path (DESIGN §9). The booth makes both variants (D14), declares them, PUTs each
one to a URL the Worker signed, and the photo is READY once both are stored and checked:

| Route | Auth | Does |
|---|---|---|
| `POST /v1/device/photos` (intent) | Bearer, `INTENT_LIMITER` per device | 200 with the photo's state: READY, REJECTED `{reason}`, or PENDING with `uploads` for the variants not yet stored |
| `PUT /v1/device/uploads/{photoId}/{variant}?exp&sig` | the signed URL only | Streams the body into R2 with the declared sha256, walks its headers, then 200 STORED (the first variant) or 201 READY (the second) |

Code: `routes/device/photos.ts`, `routes/device/uploads.ts`, `lib/uploadUrl.ts` (the signer),
`domain/jpegHeaders.ts` (the header walk), `domain/processPhoto.ts` (check + publish),
`domain/media.ts` (object keys).

### Why bytes go through the Worker (DESIGN §9.4, in brief)

Cloudflare documents both a Worker-binding upload and presigned R2 URLs. Presigned URLs win for big
files, multipart, or high-volume uploads from untrusted browsers; a Worker in the path wins when the
upload needs authorisation, validation and a synchronous answer. Ours are 0.25–0.62 MB variants from
five owned tablets at about 0.5 photos a second at peak, so the Worker path is simpler *and* safer:
no S3 key pair exists anywhere, integrity is checked in-path, and the booth learns READY in the same
request. It stops fitting only with files near 100 MB, resumable uploads, browser uploads at volume,
or ~100× the volume. The switch would be server-only, because the booth already treats the upload
as an opaque descriptor (method, URL, an open `headers` map, `expiresAt`) and understands 202:

- `UploadSigner` (`lib/uploadUrl.ts`) is the seam where SigV4 presigning replaces the HMAC signer.
- `processPhoto()` and the header walk take no HTTP types (a test checks the source), so an R2
  object-created notification → Queue consumer could call the same function.
- **Why a 202 exists although the MVP never sends it:** with D14 the PUT does no processing, so it
  always answers synchronously. The booth treats `202 {state: "PROCESSING"}` like a retryable
  response, so an asynchronous path later needs no app release (DESIGN §9.2).

### Why the Worker validates but never decodes (D14, spike Q6/Q10)

The spike tried the Images binding: on real Cloudflare it **kept GPS and camera/lens serial
numbers** whatever `metadata` was set to (local `wrangler dev` strips them, so a local test would
have passed), it needs Workers Paid for CPU (355–470 ms per photo), and it caps inputs at 20 MB. The
booth re-encodes instead (08b), and the Worker only proves the stored bytes are what the booth's
encoder writes. That costs about 1 ms of CPU per request (spike Q11: sha256 put + header check p50
1 ms, p95 1 ms), so the account stays on Workers Free. Spike wall times for the put and check from
Auckland: HD p50 334 ms / p95 449 ms, thumb p50 278 / p95 361 ms. Streaming the body into
`put(key, request.body, {sha256})` costs 0–1 ms CPU even for 17 MB (Q2), so nothing is buffered.

**The header walk** (`checkJpegHeaders(head, tail)`) reads the first 64 KB and the last 2 bytes:

- SOI; then only APP0 starting `JFIF\0`, APP14 starting `Adobe`, DQT, DHT, DRI and exactly one
  SOF0 (8-bit, non-zero size) before SOS, and the SOS header must end inside the 64 KB. Anything else
  fails with a named reason (`segment 0xe1 not allowed`, `SOS past 64 KB`, `no EOI`, …), which
  becomes the photo's `reject_reason`.
- Baseline means one scan, so nothing can hide between scans beyond the walked range (progressive
  files carry segments between scans, and Sony's MPF previews sit after EOI).
- The object must end in `FFD9`. Only the last 2 bytes are read, so a trailer that itself ends in
  `FFD9` passes.
- The rules are the booth's `check_segments` (`crates/photobooth-core/src/variants/segments.rs`)
  minus its scan walk, which the Worker can't afford, plus one check the encoder's output always
  passes: the APP0/APP14 identifiers (a JFXX APP0 carries a thumbnail). A pair made by the booth's own encoder is committed
  (`scripts/fixtures/booth-{thumb,hd}.jpg`, synthetic pattern, no photo) and a test uploads it, so a
  change on either side that breaks the other fails CI.
- Size rules (`processPhoto`): the HD's SOF size must equal the declared `width`×`height`; the
  thumb's long edge must be ≤ 480 px.
- A variant that fails is **deleted from R2 at once** and the photo becomes REJECTED; it never
  becomes READY. The photo's other variant, if already stored, stays until the event is purged; it is
  never served. The delete runs even when the photo is already REJECTED, so a bad object written by
  a racing PUT doesn't stay behind.

**Accepted risk (DESIGN §13).** Without a re-encode on the server, the entropy-coded data reaches
guests' browsers as the booth wrote it. A crafted scan, or a trailer that ends in `FFD9`, could aim
at a browser decoder bug or smuggle data. Only enrolled, revocable tablets can upload (bearer for
the intent, a signed URL per variant, and the PUT re-checks the device), browsers' JPEG decoders are
heavily fuzzed, and media is served as `image/jpeg` with `nosniff`. Revisit if uploads ever come
from devices we don't own.

### Signed upload URLs

- HMAC-SHA256 with the `UPLOAD_KEY` secret over `photoId|variant|bytes|sha256|exp`, valid 15
  minutes. The URL carries only `exp` and `sig`; the PUT reads the declared bytes and hash from the
  photo row and recomputes, so a URL is good for one variant of one photo with exactly those bytes.
- The signature is checked first and in constant time, then the expiry, so a tampered `exp` is 403
  whether or not it is in the past, and only a genuine URL can be 410. `exp` must be canonical
  decimal, so one expiry has one signed spelling.
- **An unknown photo gets the same 403 as a bad signature**, so a URL tells a prober nothing about
  which photos exist. (The photo row is read before the HMAC is computed, so an unknown ID answers
  a few microseconds sooner; with UUIDv7 IDs that oracle is worth nothing.)
- **Replay:** a READY photo answers 201 without reading the body (a test replays the URL with other
  bytes and checks the object wasn't rewritten); a REJECTED photo answers 422; a PENDING one can only
  receive the declared bytes, because R2 checks the sha256. A revoked device's URLs stop working at
  once and a deleted event's too, because the PUT re-reads both.
- **The PUT doesn't write the heartbeat:** it carries no bearer or device headers (the booth sends
  them on the intent, which precedes every PUT).
- `UPLOAD_KEY` is a Wrangler secret (`secrets.required` in `wrangler.jsonc`, so `wrangler types`
  knows it). Locally `wrangler dev` reads it from `.dev.vars` (copy `.dev.vars.example`, a
  local-only value); the Vitest config sets a test key. A signer with a missing or short key (< 32
  characters) throws, so a misconfigured Worker fails closed with 500. **Rotating it** makes every
  outstanding URL a 403, which the booth treats as needs attention (the operator's retry re-intents
  and gets a fresh URL): rotate between events, when every booth shows a zero backlog.

### Idempotency, concurrency and failure (DESIGN §9.2)

- **The intent** uses 03's single-statement insert (photo limit and `UNIQUE(device_id,
  client_photo_id)`), so a retry never makes a second photo. A retry must repeat the whole
  declaration (event, both hashes and byte counts, the HD size), or it is 409 `conflict`.
- **Closing uploads blocks new photos only.** When the event no longer accepts uploads (CLOSED,
  DRAFT, past `uploads_until`), a photo that was already accepted is still answered with its state
  and fresh URLs, because re-POSTing the intent is how the booth recovers from `upload_expired`.
  Only a new photo gets 409 `event_closed`. A **deleted** event refuses everything with
  `event_closed`, and an unknown event is 404.
- **The PUT** writes to a fixed key, so retries overwrite the same object with the same bytes.
  `markVariantStored` and the conditional `publishPhotoIfComplete` run in one batch; the publish
  changes one row for exactly one request, and every other request re-reads the photo. Two
  concurrent PUTs of the last variant both answer 201 READY.
- **Partial failure:** anything failing before that batch (R2 or D1 down, a crash) leaves the photo
  PENDING, and a retry redoes the check and the batch. Infrastructure errors are 500s, which the
  booth retries; a missing object after the put is an error, not a rejection.
- **Event deleted between the two variants:** the publish checks the event, so nothing becomes
  READY; the second PUT itself gets 409 `event_closed` (or, if the deletion lands after its checks,
  200 STORED with the photo still PENDING). If the event is then restored, the next intent sees
  both variants stored and publishes the photo.
- **Objects left behind** (never served, because only READY photos are; the event purge's prefix
  delete removes them): the stored sibling of a rejected variant, and a bad variant whose own check
  failed on an infrastructure error after a concurrent request had already rejected the photo (its
  retries get 422 before reaching R2). A photo deleted by an admin during a PUT is cleaned up: the PUT
  deletes its object and answers 404.
- `width`, `height` and `variant_bytes` come from the intent and the HD's SOF check proves the stored
  HD matches them, so the publish only sets `state` and `published_at`.

### PUT responses

| Case | Response |
|---|---|
| Malformed photo ID or unknown variant | 404 `not_found` |
| Unknown photo, bad or missing signature, a URL signed for other bytes | 403 `forbidden` |
| Expired (genuine) URL | 410 `upload_expired`: re-POST the intent |
| Revoked device | 401 `unauthorized` |
| Deleted event | 409 `event_closed` |
| READY photo | 201 READY, body not read |
| REJECTED photo | 422 `invalid_image` |
| Content type not `image/jpeg`, or `Content-Length` missing or not the declared bytes | 400 `invalid_request` |
| Bytes don't match the declared sha256 (R2 error 10037; nothing is stored) | 422 `hash_mismatch` |
| Header walk or size rule failed (object deleted, photo REJECTED) | 422 `invalid_image`, the reason in the message |
| Stored, the other variant still missing | 200 `{state: "STORED", photoId, variant}` |
| Stored, the photo is now READY | 201 `{state: "READY", photoId}` |

### Rate limit and logging

- `INTENT_LIMITER`: 120 intents a minute **per device** (keyed by the device ID after
  authentication, never by IP), answered with 429 `rate_limited` and `Retry-After: 60`. The booth's
  outbox drains a backlog with two upload workers, about one intent a second each on a good uplink,
  so 120 a minute lets a backlog drain at full speed while capping a runaway or stolen tablet at
  about 170,000 rows a day, which the per-event photo limit (2,000 by default) stops much sooner.
  The PUT has no rate limit: a genuine upload needs a URL from a limited intent, and a forged PUT
  costs one D1 read (the photo row) before its 403. A flood of forged PUTs is the account-wide
  denial-of-service case DESIGN §13 leaves to the zone's WAF rate-limiting rule (SETUP C).
- The access log line carries `deviceId` on every authenticated device request, and `eventId` and
  `photoId` on intents and PUTs (`addLogIds` in `middleware/accessLog.ts`). The path is logged
  without its query, so `sig` never reaches the Worker's own logs (a test checks).
- **Cloudflare's invocation logs** (Workers Logs, `observability.enabled`) record each request's URL
  themselves, query included, unless `observability.redact_query_string` is set, which it is in
  `wrangler.jsonc` (inherited by staging and production). Without it every upload URL, signature
  included, would sit in the dashboard's logs and in `wrangler tail` for the retention period.
  **Unverified until staging (07):** that the redaction covers `wrangler tail` and the invocation log.

### What was verified, and where

Everything above runs locally: Vitest in workerd with real local D1 and R2 (local R2 enforces
`sha256` with the production error, spike Q9), and `scripts/smoke.ts` against `wrangler dev`
(create and open an event and a device, enrol, intent, PUT thumb → 200 STORED, PUT hd → 201 READY,
re-intent → READY; the stored objects' sha256 match the fixtures). Nothing in this path depends on a
binding that behaves differently remotely: no Images binding, and R2's `sha256` check, range reads
and streaming behaved the same in the spike's remote runs. **Not verified on real Cloudflare:** this
code itself (no deploy), CPU per request (the 1 ms figure is the spike's), the suffix range read
and the full-object `size` that a ranged `get` reports (which `processPhoto` uses to skip the second
read for objects up to 64 KB; the spike only ran the 0–64 KB read remotely), the Rate Limiting
binding's real behaviour (approximate, per location), and concurrent PUTs on remote D1 (local D1
serialises statements, so the concurrency tests prove the conditional UPDATE, not remote
scheduling). Session 07 checks the path on staging.

## Guest access and the gallery API (session 11)

Routes on the photos host, all under the event's path `/e/{publicId}/`:
`POST …/api/session {token}`, `GET …/api/photos?cursor&session&limit`, and
`GET …/m/{photoId}/{thumb|hd}[?download=1]`. Code: `lib/guestCookie.ts`, `middleware/guestAuth.ts`,
`routes/guest/`.

### Fragment → cookie

The share link is `/e/{publicId}#k={token}`. The token sits in the fragment, so it is never sent
in a request line, never logged, and never leaks in a `Referer` (DESIGN §11). The SPA (session 12)
POSTs it once to `…/api/session` and removes the fragment; from then on the browser holds a cookie
instead. The token comparison is constant-time (`timingSafeEqual`), and the event must be LIVE and
not deleted (`galleryVisible`, no time limit since D15). A gallery past its upload window still
opens.

### A stateless cookie checked against `access_version`

The cookie `g` is `{eventId}.{accessVersion}.{exp}.{sig}`, with `sig` = HMAC-SHA256 over
`eventId|accessVersion|exp` with `SESSION_KEY`. There is no session table (D10). Each request:

1. checks the signature and expiry before any D1 read, so a forged cookie costs no rows;
2. reads the event by `publicId` (one row, the `UNIQUE` index) and requires the cookie's event,
   gallery LIVE, not deleted, and the same `access_version`.

So **rotating the link** (which bumps `access_version`), **suspending** the gallery or **deleting**
the event takes effect on the very next request, with no revocation list. Suspension is a pause:
publishing again lets the same cookies and link back in; only rotation revokes them. The fields are
in clear because none is secret (the cookie is `HttpOnly`, and the event ID gives its holder nothing
the link didn't). The cookie lasts 30 days and doesn't slide: a guest returning after a month
reopens the link.

**Path-scoped cookies, one per event.** `Path=/e/{publicId}`, `HttpOnly`, `Secure`,
`SameSite=Lax`, `Max-Age=2592000`. A guest at two events holds two cookies with the same name and
different paths, and each is sent only to its own event. A cookie presented on another event's path
fails the event check anyway (tested).

### Why every refusal is the same 404

Wrong or old token, unknown event, suspended, hidden or deleted gallery, a malformed body; a
missing, forged, expired or stale cookie: all get the same `404 not_found` "Not found." with
`no-store`. A different status or message would let someone holding a forwarded or guessed link tell
"this event exists but is suspended" from "wrong link", or confirm that an event exists at all. The
cookie check's refusals also clear the cookie (`Max-Age=0` on the same path), so a browser stops
sending a dead one. The two answers that differ say nothing about any event: **429** with
`Retry-After: 60` when the caller's own IP is over the session limit (checked before anything else),
and **400** for a bad query on the photo list, which only a holder of a valid cookie can reach.

### The list: cheap enough to poll

The list is the gallery's polling target (30 s while `eventOpen`, 10 s for the post-shoot session
view), so its cost is pinned by tests through the access log's `rowsRead` (the event row plus each
query's `meta.rows_read`): **1 event row and at most 26 photo rows** for a page of 24 (the page, one
row to know there is a next page, and the boundary row a cursor seek lands on). The keyset cursor
(`published_at`, `id`) keeps pages stable while photos arrive: new ones sort before the cursor, so
they never shift a later page.

The session filter (`?session=`) is the post-shoot view's. With the original
`photos_session (event_id, session_id)` index SQLite chose `photos_gallery` and read every READY
photo of the event to find one session's few: on a 2,000-photo event, the 12 polls of one session
view would read about 24,000 rows, and a busy event day could spend half of D1's free 5 M rows on
it. Migration `0002` widens `photos_session` to `(event_id, session_id, state, hidden,
published_at, id)`, the gallery index's shape with the session added, and a session page now reads
about one page of rows (tested). A session ID from another event matches nothing here, so it gives
an empty page.

### Media: immutable private caching

Media follows DESIGN §11's four steps (cookie; event row; photo row: this event's, READY, not
hidden; then R2): two D1 rows per request. The row check holds on its own: the R2 key also contains
the event ID, but a test puts a stray object under the wrong event's prefix and still gets the 404.
`Cache-Control: private, max-age=31536000, immutable`:

- **Immutable** because a key never changes content (fixed keys, D6, and a READY photo takes no
  more uploads). The browser never revalidates, which matters more than bytes: on Workers Free every
  refetch is a request against the account's 100,000 a day (spike Q12), and a guest scrolling back
  through a grid of 24 thumbnails would otherwise cost 24 requests each time.
- **Private** so no shared cache keeps a guest's photo. The Worker runs first for every request, so
  nothing is served without the access check.
- **The trade-off:** a photo a browser has already loaded stays in that browser's cache after the
  link is rotated, the gallery suspended or the photo hidden. Those controls stop new views, not
  copies a guest already has (which they could have saved anyway).

A refusal is `no-store`, never cached like the media it stands in for. `?download=1` adds
`Content-Disposition: attachment; filename="<event-slug>-<session>-<shot>.jpg"`: the slug folds
accents and keeps only `a-z0-9-` (at most 40 characters, `photo` if nothing is left), so the header
needs no escaping. Session and shot keep a guest's downloads distinct and in strip order. `download`
with any other value is inline. Only `thumb` and `hd` exist; anything else is the 404.

### Rate limit, secrets and config

- `SESSION_LIMITER`: 60 swaps a minute per IP (an IPv6 address by its /64, `ipRateKey`). A guest
  swaps once per link opening, but a venue's guests often share one Wi-Fi address, so the limit
  allows a crowd scanning the QR at once. The token is 128 bits, so the limit isn't what stops
  guessing; it bounds the D1 rows a flood can spend.
- `SESSION_KEY` (at least 32 characters, `secrets.required` in every environment) signs the
  cookies, separate from `UPLOAD_KEY`. Without it every guest request fails closed (500). There is
  one key at a time, so rotating it logs every guest out (they reopen the link).
- `CONTACT_ADDRESS` and `CONTACT_EMAIL` are in every list response (the footer's removal contact).
  Local placeholders are in `wrangler.jsonc`; staging and production are still empty, so the list
  answers a logged 500 (`internal_error`) there until session 07 sets them.
- The swap accepts only `Content-Type: application/json`. A cross-site page can't send that without
  a CORS preflight, which the Worker never answers, so it can't plant its own gallery's cookie in a
  visitor's browser (login CSRF; harmless here, but free to stop).

### What was verified, and where

Vitest in workerd (local D1 and R2): every DESIGN §11 *Media* step and the §13 cross-event row have
named tests; rotation, suspension and deletion are checked on the very next request through the real
admin API; 17 mutations of the checks were each caught. `scripts/smoke.ts` against `wrangler dev`
covers the guest path after READY. **Not verified on real Cloudflare:** the cookie in a real browser
on the real HTTPS domain (session 12 tries `photos.localhost` in a browser), the Rate Limiting
binding's real behaviour, `CF-Connecting-IP`, and remote D1's `rows_read` counts (the tests pin
local SQLite's).

## Guest gallery UI (session 12)

`src/web/gallery/`: React 19, one view plus a lightbox. The design target is
[portal/design/](./portal/design/) (the owner's claude.ai Design canvas, exported), graded against
its README's criteria; the screenshots are in `portal/design/screenshots/`.

### Shape: no router, no service worker

- **One view, two filters:** the event (`/e/{publicId}`) or one booth session (`?s={sessionId}`).
  The open photo lives in `history.state`, so Back closes the viewer, then leaves a session view, as
  a guest expects. A router would add a dependency (DESIGN §5 rules them out) for two states.
- **No service worker or offline mode** (out of scope): the browser already caches media
  immutably (session 11), which is the part that saves requests; a worker would add a second cache
  to get wrong on rotation.
- **Pure modules under the views**, each tested alone: `link.ts` (parse `#k`/`&s`/`&n`, the clean
  URL), `feed.ts` (pages, the pending list, session groups), `poller.ts` (rates, visibility),
  `api.ts`. `App.tsx` wires them; its tests drive it with a fake clock and a fake `fetch`.

### The link

The SPA reads `#k`, replaces the address with `/e/{publicId}[?s=…&n=…]` *before* the swap
resolves, then POSTs the token (`api/session`). The token never stays in the address bar, history
or a bookmark, whatever the answer. Without `#k` it tries the cookie (`api/photos`). Any 404
(token or cookie) shows one page, "This gallery isn't available", worded the same for every cause
(design criterion 5; the API already makes them indistinguishable). A 429 waits `Retry-After`; a
network failure offers "Try again". A new `#k=` in the same tab (a second booth QR) reloads.

`&n={shots}` is new in session 12: the booth's shots per session (`number_of_photos`, 1–10), which
the gallery can't learn from the API. It sizes the placeholders; session 13 adds it to the QR link
beside `&s=`. Without it the session view shows one "On its way" tile. Either way placeholders
show only for the first 2 minutes and while the event is open, so a shot that never arrives never
leaves a placeholder waiting for ever.

### Polling and its request cost

Every poll is one Worker request against the account's Workers Free 100,000 a day, shared by every
guest, booth and admin (DESIGN §16, spike Q12), so the rates are the plan's and no faster:

- **30 s ± 10 % jitter**, only while `document.visibilityState === "visible"` and the last answer
  said `eventOpen`; one poll the moment the page is visible again. A closed event is never polled.
  The jitter keeps a room of phones that scanned together from polling in lockstep.
- **10 s ± 10 % for the booth session's first 2 minutes**, then 30 s. Only a session view opened
  from the booth's link (`#k` with `&s`) gets it; a session opened from the event view is history.
  A guest who keeps the session view open for 2 minutes costs 12 polls, then 2 a minute.
- Never two polls at once; answers for a view the guest has left are dropped.
- A 200-guest evening at 30 s, with a third of the guests looking at any moment for 4 hours, is
  about 200 × ⅓ × 480 ≈ 32,000 polls: inside the spike's typical event-day estimate.
- Polls read the first page only (no cursor) and diff by ID. If a whole polled page is new and
  more follow (a tab hidden through a busy spell), photos may sit between it and the grid, so
  tapping the pill reloads the first page instead of merging.
- A 429 holds the poll for `Retry-After` before the next one is scheduled.

### "N new", without moving the grid

New photos from a poll wait in `feed.pending` behind a pill that floats over the grid (a sticky,
zero-height slot, so its arrival moves nothing; `aria-live` announces it). Tapping it puts them on
top, scrolls to the top (smoothly unless the guest prefers reduced motion) and moves focus to the
heading. Nothing is inserted above what the guest is looking at without that tap. The session view
is the exception: its shots fill their placeholders in place (same slot, same size), because that
is what the view is for.

### Layout that can't jump

Every tile has a fixed shape before its image loads: square in the event grid (a 2 × 2 "hero" for
about one session in three with 3 or more photos, chosen by a hash of the session ID so it's the
same on every visit and every phone), 2:3 in the session view. Thumbnails are `loading="lazy"` with
the API's width and height. Older pages load by cursor when a "Show older photos" button nears the
viewport (`IntersectionObserver`); the button also works on its own (keyboard, no observer).

### Viewer

A modal dialog (dark, decided with the owner): the HD variant, `Download` (`hd?download=1`),
swipe or arrow keys, Escape or Back to close, Tab kept inside, focus returned to the photo it was
opened from, and the page behind made `inert`. **Share** appears only where `navigator.canShare`
accepts files: on iPhone that is how a photo reaches Photos (a download goes to Files). It reads
the HD file after the image has loaded, so the read is a cache hit, not a request, and the share
call stays inside the tap's user activation. No named targets and no link sharing (the link is the
whole event's access).

### Fonts and the CSP

Geist is copied from the booth into `src/web/ui/fonts/` (the identity the two apps share; the
owner chose Geist over the canvas's Figtree). The CSP is `default-src 'self'`, so no web fonts from
elsewhere and no `data:` fonts: Bun inlines fonts into the CSS as `data:` URIs, so `build.ts` moves
them back out to hashed files (the booth's build does the same) and fails if any `data:` URI
remains. They load with `font-display: swap`, so text never waits for them.

### Accessibility checks performed

- Keyboard only, in a browser against `wrangler dev`: tiles and session links in order, the viewer
  opened from a tile with focus on its close button, arrows move, Tab cycles inside, Escape closes
  and focus returns to the tile; the "N new" pill moves focus to the heading.
- Labels: every tile is a link named "Photo N of M, 9:42 PM"; icon buttons have names; the session
  view's status line and the pill are live regions.
- Contrast (WCAG 2.x formula, `design/tokens.md`): body text 17.8:1, secondary 6.3:1 (5.9:1 on the
  grey card), dark-viewer secondary 9.8:1; focus is a 3 px blue outline (white inside the viewer).
- `prefers-reduced-motion`: the stylesheet turns off the pill's entrance and the placeholder
  shimmer, and the pill's scroll is instant. Checked by reading the rules and the code; the
  built-in browser can't emulate the media query, so it was **not run** emulated.
- Every control is at least 44 × 44 px.

### What was verified, and where

`bun test` with happy-dom (the tests are listed in PROGRESS.md), and a browser at 375 × 812 against
local `wrangler dev` with the seed plus placeholder sessions uploaded through the real device API:
the token swap and fragment stripping, the session view's placeholders filling within one 10 s
poll, the pill after a 30 s poll while scrolled, the viewer, the footer and the unavailable page; no
console errors other than the expected 404. Page weight on the local server: about 77 KB compressed
before fonts (HTML, CSS, JS, the first API page), three fonts of about 60 KB each after first
render, then the visible thumbnails. The "first grid under 2.5 s at 10 Mbps" target is an
**estimate** from these sizes, not a throttled measurement. **Not verified:** a real phone (13's
once-over), iOS Share to Photos, real Cloudflare and HTTPS.

## Retention and deletion (session 16)

The daily job (`jobs/retention.ts`, rules and budget in `domain/retention.ts`) does two things and
nothing else. **There is no photo expiry** (D15): photos and the gallery stay until an admin deletes the
event, and `uploads_until` only closes uploads, which the intent route enforces.

1. **Purge deleted events** whose 7-day undo has run out (`purge_after <= now`). The whole R2 prefix
   `events/{eventId}/` is deleted (lists of up to 1,000 keys, then one batch delete of those keys), then
   the event row, whose photo rows go with it (`ON DELETE CASCADE`), in one atomic `db.batch` with an
   `event.purge` audit row (actor `system`, detail `{name, photos}`).
2. **Prune audit rows** older than 90 days, 500 per statement, with an `audit.prune` row saying how many.

Why a prefix delete: a deleted event's prefix holds more than its READY photos' objects. It also
holds variants of PENDING and REJECTED photos, and anything written late. Deleting by prefix instead
of by row makes all of them harmless. The trailing slash in the prefix keeps one event's prefix from
matching another's. There is no `incoming/` prefix (D14).

Why no object can arrive during the purge: from the deletion on, an intent or a PUT for the event is
refused (409 `event_closed`), and an upload URL lives 15 minutes, so 7 days later nothing is in flight.
The final batch is still guarded (`deleted_at IS NOT NULL AND purge_after <= now`) so an event
restored in the meantime keeps its row and writes no audit row; the admin API itself refuses a restore
once `purge_after` has passed (409), and a purged event is a 404. We keep the event's R2 objects only
while it is restorable, so a restore that races the job in the same second is the one case that could
lose a restorable event's photos (a clock edge, logged as `retention_event_restored`).

**Why the event row is deleted rather than marked `purged_at`:** the audit row keeps the event's ID,
name and photo count for 90 days (the `audit` table has no foreign key, so it outlives the event), so
no extra column or migration is needed, and nothing else needs to read a purged event. Session 16
therefore adds **no migration**.

**Idempotent and resumable.** Each step can be repeated: listing an empty prefix and deleting a gone
row do nothing. An event stays deleted until its prefix is empty, so the next day's run finds it again
and carries on. State lives in the data, not in the job.

**Work budget (Workers Free: 10 ms CPU, 50 subrequests, every D1 and R2 call counts).** Per run:
at most 40 calls (10 left as headroom), 4 of them kept for the prune, 2,000 objects deleted (R2's CPU
is per key), pages of at most 1,000 keys, 10 events started, at most 1,500 audit rows pruned. An
event of 2,000 photos has 4,000 objects, so it takes three days; deleted events are rare, so the backlog
is small. A run with nothing to do makes two calls. If any event fails (an R2 error), the others and
the prune still run, the failure is logged (`retention_event_failed`, event ID and error name only), and
the invocation then throws so it shows as an error in Observability; the next run resumes.

**Logs** (DESIGN §15; allowlisted fields only, counts and IDs, never names, tokens or error messages):
one `retention_run` line per run with `purgedEvents`, `pendingEvents`, `deletedObjects`,
`prunedAudit`, `failures`, `subrequests`, `durationMs`, plus `retention_event_purged` per event.

**Admin visibility.** The events API already returns `uploadsUntil`, `deletedAt` and `purgeAfter`, and
refuses a restore after the purge date (409) and for a purged event (404). Showing "Uploads close on"
and "Purges on" is the admin UI's (session 14, outside this session's allowed files).

**Trigger locally:** `wrangler dev` serves `/cdn-cgi/handler/scheduled?cron=0+14+*+*+*&time=<epoch ms>`;
`time` becomes the run's clock, so a deleted event can be purged without waiting 7 days. That makes it
destructive: never trigger the handler with a future `time` on staging or production (a restore could race
the job's object deletes); use it only on a local `wrangler dev`.

### What was verified, and where

Vitest in workerd (local D1 and R2): the purge boundary (the exact millisecond and one before), an
event past `uploads_until` kept, a restored event kept, 2,500 objects across two runs, a full page,
late and stray variants, a lookalike prefix untouched, the audit prune boundary and batching, an
idempotent re-run, an R2 failure, a restore racing the final write, the subrequest count of every run
(measured with counting wrappers and asserted equal to the job's own count and ≤ 40), and the log
lines. The same job ran under `wrangler dev` via `/cdn-cgi/handler/scheduled`. **Unverified:** the
CPU time of a full-budget run on Cloudflare (local workerd's timings mean nothing). The budget is a
conservative guess; measure it on staging with `wrangler tail --format json` (the `cpuTime` of the
scheduled event) with 2,000 objects waiting, and reduce `RETENTION_LIMITS.objects` if it is near 10 ms.
Also unverified on real R2: that `list`'s `truncated` is false on an exactly full last page, and that
the cron fires.

## Admin UI: events, event QR and devices (session 14)

`src/web/admin/`: five views (events list, event detail, create/edit form, devices, an audit
placeholder for 15) plus Not authorised and Not found, over the same `src/web/ui/` tokens and fonts as
the gallery. Plain and functional by design.

### Shape: no router, and why the Worker serves those paths

`nav.tsx` wraps the History API (`pushState`, `popstate`, a `Link` that leaves modified clicks to the
browser). With five views a router library would be most of the bundle's size for nothing. The price is
that deep links must work on reload: the admin host used to serve the shell only for `/`, so
`routes/admin.ts` now serves it for exactly `/`, `/events`, `/events/new`, `/events/{id}` (+ `/edit`),
`/devices` and `/audit` (GET only) and answers everything else, unknown `/api/` paths included, with the
JSON 404. The SPA's own "page not found" is therefore only reachable by client-side navigation. Keep
`SPA_VIEWS` (Worker) and `parseRoute` (SPA) in step; a test on each side pins its list.

### Event times: wall clock in the event's zone

The form takes `datetime-local` values and the zone from a picker (`Intl.supportedValuesOf`, New Zealand
by default). `time.ts` converts with `Intl` only (no date library): it tries the zone's offset a day
before and a day after the typed time and keeps the instant that reads back as exactly what was typed. A
time the clocks skip (spring forward) is refused with a message; a repeated time (clocks back) takes the
first occurrence. Changing only the zone on an edit moves the stored instants, because the admin sees and
edits wall-clock times. An edit sends only the fields that changed, so the audit row's `fields` is the
real edit. The server still checks the merged row (`endsAt >= startsAt`) and recomputes `uploads_until`.
The browser's zone list uses its own names (Chrome lists `Asia/Calcutta`); a name workerd's ICU didn't
know would be a 400 shown as "check the form" (**not seen**, but possible for exotic zones).

### Actions, confirmations and what the admin is told

`rules.ts` mirrors the Worker's state machine to decide which buttons exist (the Worker stays the
authority and answers 409). Open, publish and restore go straight through. Close, suspend, rotate and
delete ask first, and the dialog opens on Cancel:
- **Rotate** says every link and QR stops working at once and printed signage must be reprinted.
- **Suspend** says it is a pause (Publish brings the same link back) and that rotation is the revoke;
  images a guest already viewed stay in their browser cache either way (session 11's note).
- **Delete** says 7 days to restore, then permanent.
- **Close uploads** reads the devices list at that moment and warns for each enrolled, unrevoked booth
  with a non-zero last-reported backlog, and separately for booths whose queue we can't vouch for (never
  reported, or silent for over 10 minutes: a booth that is offline can't report a backlog, and that is
  exactly when it has one). A device isn't tied to an event in the data model, so this is every booth,
  which is also the runbook's rule (DESIGN §15: close only when every booth shows zero). If the devices
  call fails the dialog says the queues couldn't be checked. Closing is never blocked: the admin may know
  better.
Event detail shows "Uploads close on" (`uploadsUntil`) and, for a deleted event, "Purges on".

### Event QR

`qrcode-generator` 2.0.4 (MIT, no dependencies, ~50 KB unminified) supplies only the module matrix
(byte mode, error correction Q: signage gets scuffed). The SVG (one path of horizontal runs, 4-module
quiet zone, white background, no external references) and the PNG raster (about 1000 px, from the same
RGBA buffer) are drawn by our own code, so what goes to a printer is the matrix and nothing else. `jsqr`
1.4.0 is a **dev dependency** used only by tests to decode our SVG and raster back to the exact link, token
fragment included. The QR encodes `galleryUrl` from the admin API unchanged: the whole-event link, no
`&s=`. Rotating changes the link and the QR with it. The on-screen code is inline SVG (no image request, so
nothing for the CSP to block); downloads are an `<a download>` on an object URL, which worked under the
Worker's real CSP in Chrome.

### Devices: the event-day health view

The table shows status, last seen (relative; an enrolled booth silent for over 10 minutes is flagged),
the last reported backlog, and the app version. It refreshes every 15 s while the tab is visible, once
when it becomes visible again, never two at a time (`refresh.ts`); each refresh is one admin request
against Workers Free's daily limit, hence visible-only. A failed refresh keeps the last data and says so.

The enrolment code is shown once, grouped (`ABCD-EFGH`), with a countdown from the server's
`expiresAt`; it lives only in the `reveal` state of the devices view. Closing the dialog, or the code
expiring, drops it: it is never put in the URL, history state, storage or the title, and the list
(which never contains it) refreshing can't bring it back. Re-issuing for an enrolled booth asks first
and says it re-enrols the tablet (redeeming replaces its credential, DESIGN §12); revoke asks first and
says the booth is locked out at once.

### Errors

`api.ts` turns the closed error codes into sentences; the server's own text is shown only for
`conflict`, which the Worker words for people. A fetch that throws, or an answer that isn't the API's
JSON, is "can't reach the server; reload the page to sign in again": when Access's session lapses the
browser is redirected to its login page, which looks exactly like that. A 401/403 from the Worker
replaces the app with the Not authorised page.

### What was verified, and where

`bun test` (happy-dom): time zone conversion (summer/winter, the date line, a skipped and a repeated
hour, round trips), the forms, the action rules and every confirmation, the code lifecycle, QR decoding,
polling and visibility, the history wrapper, error mapping. In **real Chrome** (headless over CDP,
against local `wrangler dev --var DEV_AUTH:1` after `migrate:local` + `seed`; the script is throwaway)
the whole lifecycle ran: create in NZ time (stored `2026-12-20T01:30:00.000Z`), open, publish, the QR and
both downloads (`…-gallery-qr.svg` and `.png` produced), the close warning with a booth reporting a
backlog of 7, rotate (link changes), delete and restore, create a booth code (shown once, gone from the
DOM, URL, title and storage after Done and after a refresh cycle), re-issue, revoke, deep-link reload.
Screenshots: `wiki/portal/screenshots/14-*.jpg`. **Not verified:** a phone scan of the printed or
on-screen QR (decoded only in tests, and the downloaded PNG file itself was not re-decoded), real
Cloudflare Access (the dev auth path skips it), a screen reader, narrow screens (desktop first).

## Data model (D1)

The schema is `migrations/0001_init.sql`: DESIGN §6 plus the refinements listed there. The
reasons behind it:

- **No admins table.** Admins are the Access policy plus the `ADMIN_EMAILS` variable (session 04).
  A table would be a second source of truth next to Access, and a row can't stop someone Access
  lets through.
- **The share token is stored as is**, not hashed (D9): the booth shows the event QR and admins
  reprint it, so the server must be able to give it back. Rotation writes a new token and bumps
  `access_version`, which the guest cookie carries, so every old link and cookie stops working at
  once with no session table (D10).
- **Device credentials and enrolment codes are stored only as SHA-256.** They are high-entropy
  random values, so a plain hash (no salt or slow KDF) is enough, and the lookup stays one indexed
  equality. Enrolment redeems the code in one `UPDATE … RETURNING`, so a code works once even under
  concurrent requests.
- **The photo limit is one statement:** `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < photo_limit
  ON CONFLICT(device_id, client_photo_id) DO NOTHING`, then a re-select in the same batch. There is
  no reservation to reconcile. The re-select tells the three outcomes apart: inserted, an existing
  row (a retried intent; the caller compares hashes and event), or none (the limit). REJECTED
  photos count towards the limit.
- **CHECK constraints guard the invariants the code relies on** (READY ⇒ both variants stored and
  `published_at` set, REJECTED ⇔ a reason, `deleted_at` ⇔ `purge_after`). A bug that tries to
  write an impossible row fails loudly instead of publishing it.
- **Times are `toISOString()` text** in one format, so SQL compares them as text
  (`enrol_expires_at > ?`, the gallery cursor). Never store another format.
- **Writes return a prepared statement** rather than running it, so a route can put the change and
  its audit row in one `db.batch` (one transaction). Event updates are guarded by the `updated_at`
  they were read at, so two admins acting on the same read can't both win.
- **The gallery page query is built from fixed SQL fragments** with bound values, not
  `(? IS NULL OR …)`. That form stopped SQLite seeking `photos_gallery` to the cursor, so a deep
  page read every earlier row (34 rows for a 3-row page in the test), and D1 bills rows read. A
  test pins it at 5 rows or fewer.

### Domain rules (`src/worker/domain/`)

- `eventState.ts` is the event state machine. Uploads go DRAFT/CLOSED → OPEN → CLOSED; the gallery
  goes HIDDEN/SUSPENDED → LIVE → SUSPENDED; the two are independent. **Deleted** = `deleted_at` set:
  nothing is served or accepted and only `restore` is allowed, until `purge_after` (+7 days).
  **Upload window closed** = now ≥ `uploads_until` (`ends_at` + 90 days): no more uploads, and
  uploads can't be opened again. **Nothing else expires** (DESIGN D15, decided 2026-10-22): the
  gallery and its photos stay until an admin deletes the event, because events run once and early
  on we'd rather be generous about when guests can retrieve photos. The 90-day mark only stops a
  stale booth uploading into an old event. **Purge due** = deleted and now ≥ `purge_after`. Routes
  map every refusal to 409 `conflict`.
- `cursor.ts`: the keyset cursor is `published_at|id` in base64url. It is opaque to clients but
  not secret: a forged cursor can only page within the event the guest's cookie already allows.

### IDs and secrets (`domain/ids.ts`)

| Value | Format | Why |
|---|---|---|
| Row IDs | UUIDv7 | Time-ordered, so inserts append to the primary-key index and `ORDER BY id` is creation order; made in the Worker with no coordination |
| `public_id` | 16 lowercase base32 characters (80 bits) | In gallery URLs; unguessable, but it grants nothing without the token |
| Share token | 22 base64url characters (128 bits) | In the `#k=` fragment and the QR; 128 bits keeps the QR small |
| Device credential | 43 base64url characters (256 bits) | Bearer secret, stored as SHA-256 |
| Enrolment code | 8 Crockford base32 characters (40 bits) | Typed on the booth: no I, L, O or U, and look-alikes are normalised. 40 bits is safe only with the 10-minute expiry and the per-IP rate limit (session 05) |

Each character comes from one random byte masked to 5 bits; 256 is a multiple of 32, so there is
no modulo bias. Secrets are compared with `timingSafeEqual` (`domain/tokens.ts`).

## The contract: schemas and fixtures (D13)

- `src/shared/schemas.ts` holds a zod schema for every request and response body in DESIGN §8 and
  §9.1, the error shape and the error codes; the TypeScript types are inferred from them. Objects
  are strict (an unknown field fails), strings and arrays are capped, and response schemas have no
  transforms or defaults, so parsing a fixture returns it unchanged. Optional fields are omitted,
  never `null`; nullable fields are always present. serde's defaults expect the same.
- **One exception to strictness:** an upload's `headers` is an open map (header names
  `[A-Za-z0-9-]`, at most 16, `Content-Type: image/jpeg` required), and the booth sends it as given.
  DESIGN §9.4 lets the server move to presigned R2 URLs, which add headers such as
  `x-amz-checksum-sha256`; a fixed shape would make that a booth release.
- **Times are exactly `toISOString()` form** (`2026-10-22T09:30:00.000Z`). The schemas reject
  other precisions, because D1 compares stored times as text and `…00Z` sorts after `…00.500Z`.
- The intent's byte caps (thumb 200,000 and HD 3,000,000 bytes, decimal) are **not** in the
  schema: the route checks them so the booth gets 413 `too_large` rather than 400
  `invalid_request`. The HD long edge (≤ 2560) is in the schema.
- `contract/fixtures/<area>.<message>.<variant>.json` has one example of every device and gallery
  message and one of every error code. `contract/manifest.json` names each fixture's schema and,
  for responses, its HTTP status. `src/worker/contract.test.ts` checks that every file is in the
  manifest, parses with its schema unchanged, and **fails when an unknown field is added at any
  depth** (except inside `headers`), which is how a non-strict nested object gets caught.
- **Why fixtures and not shared code:** the booth is Rust. Session 09 loads the same `device.*`
  files with `include_str!` into its serde types, so a contract change that isn't made on both
  sides fails one of the two test suites. Change a fixture only together with its schema, and say
  so in the PR, because the booth and portal tracks run in parallel.
- The admin schemas have no fixtures (only the admin SPA reads them). They are a starting point
  that sessions 04, 05, 14 and 15 may refine.

## Local data

`bun run migrate:local` applies the migrations to the local D1 (`.wrangler/state`), and
`bun run seed` (`scripts/seed.ts`) replaces the local D1 and R2 contents with fixed data: an OPEN,
LIVE event with 6 READY photos in two sessions plus a PENDING and a REJECTED one, a CLOSED, LIVE
event with 2 READY photos, and one enrolled device. It prints the two gallery links and the
device's local-only credential. It goes through Wrangler's `getPlatformProxy`, so it writes the
same local state `wrangler dev` reads, and it uses the real data layer, so seeded rows obey the
same rules. Times are anchored to the current hour so event A's upload window stays open. The placeholder
images are solid-colour baseline JPEGs from `scripts/solidJpeg.ts` (APP0, DQT, SOF0, DHT, SOS and
EOI only), so the header walk (session 06) accepts them and browsers display them.

## Known limits

- The retention job's CPU on Workers Free (10 ms) is unmeasured; see "Retention and deletion".
- The health version is the `package.json` version. A git SHA arrives with the deploy workflow in session 07.
- `ENROL_LIMITER` (session 05, 10 a minute per IP), `INTENT_LIMITER` (session 06, 120 a minute per
  device) and `SESSION_LIMITER` (session 11, 60 a minute per IP) have only run in the local
  simulation: their behaviour on Cloudflare (per location, approximate) is **unverified**.
- `SESSION_KEY` has one value at a time, so rotating it logs every guest out.
- Media already in a guest's browser cache stays viewable there after rotation, suspension or
  hiding (immutable caching; see "Guest access and the gallery API").
- `UPLOAD_KEY` has one value at a time, so rotating it voids every outstanding upload URL (the
  booth's items need the operator's retry). Rotate between events.
- The gallery keeps showing a photo hidden or deleted after it loaded until the page reloads (and
  its image stays in that browser's cache). Polls only add photos.
- `GET /api/devices` is unpaginated (schema cap 1,000); there are five tablets.
- The close-uploads backlog warning covers every enrolled booth, not only those on the event (a device
  isn't tied to an event), and trusts each booth's last report (at most once a minute, see "Devices and
  enrolment").
- `ADMIN_EMAILS`, `ADMIN_SERVICE_CLIENTS`, `ACCESS_*` and `CONTACT_*` are empty vars in staging and
  production, so a deployed Worker refuses every admin request, and answers the gallery list with a
  500, until session 07 sets them. Only the local config has contact values.
- Admin auth is tested only against tokens signed locally. The real Access JWT shape (`common_name`
  on service tokens, `aud` as an array) follows Cloudflare's docs and is **unverified** until
  staging (session 07).
- The certs cache is per isolate, so each new isolate fetches the certs once.
- `GET /api/events` is unpaginated and the response schema caps it at 1,000 events, so the list
  would return a 500 past that. At about four events a month that is decades away; paginate it
  (session 14 or later) well before then.
