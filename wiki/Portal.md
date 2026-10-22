# Portal

The guest web portal: one Cloudflare Worker in `apps/portal`. The behaviour spec is
[portal/DESIGN.md](./portal/DESIGN.md) and the build plan is [portal/README.md](./portal/README.md).
This page records *why* the code is shaped the way it is, and is extended as each session lands.

**Status (session 06):** the scaffold (02), the D1 schema, data layer, domain rules and shared
contract (03), admin authentication (Cloudflare Access JWT, verified in code) and the admin events
API with audit rows (04), devices: the admin devices API, enrolment and the authenticated device
events API (05), and the live-delivery path: the upload intent, the signed per-variant PUT, the JPEG
header walk and `processPhoto()` (06). There are no guest API routes yet. **Nothing here has run on
real Cloudflare or against a real Access application.** It is verified with Vitest in workerd (local
D1 and R2, JWTs signed with a locally generated key), `wrangler dev` with `scripts/smoke.ts`,
`wrangler d1 … --local` and `wrangler deploy --dry-run` only.

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
The scheduled handler is a no-op that logs; retention arrives in session 16.

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
  which photos exist.
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
  The PUTs are not rate-limited: each needs a URL from a limited intent.
- The access log line carries `deviceId` on every authenticated device request, and `eventId` and
  `photoId` on intents and PUTs (`addLogIds` in `middleware/accessLog.ts`). The path is logged
  without its query, so `sig` never reaches the logs (a test checks).

### What was verified, and where

Everything above runs locally: Vitest in workerd with real local D1 and R2 (local R2 enforces
`sha256` with the production error, spike Q9), and `scripts/smoke.ts` against `wrangler dev`
(create and open an event and a device, enrol, intent, PUT thumb → 200 STORED, PUT hd → 201 READY,
re-intent → READY; the stored objects' sha256 match the fixtures). Nothing in this path depends on a
binding that behaves differently remotely: no Images binding, and R2's `sha256` check, range reads
and streaming behaved the same in the spike's remote runs. **Not verified on real Cloudflare:** this
code itself (no deploy), CPU per request (the 1 ms figure is the spike's), the Rate Limiting
binding's real behaviour (approximate, per location), and concurrent PUTs on remote D1 (local D1
serialises statements, so the concurrency tests prove the conditional UPDATE, not remote
scheduling). Session 07 checks the path on staging.

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

- The health version is the `package.json` version. A git SHA arrives with the deploy workflow in session 07.
- `ENROL_LIMITER` (session 05, 10 a minute per IP) and `INTENT_LIMITER` (session 06, 120 a minute per
  device) are used; `SESSION_LIMITER` is declared but unused, and its threshold is a placeholder. The
  limiter has only run in the local simulation: its behaviour on Cloudflare (per location,
  approximate) is **unverified**.
- `UPLOAD_KEY` has one value at a time, so rotating it voids every outstanding upload URL (the
  booth's items need the operator's retry). Rotate between events.
- `GET /api/devices` is unpaginated (schema cap 1,000); there are five tablets.
- `ADMIN_EMAILS`, `ADMIN_SERVICE_CLIENTS`, `ACCESS_*` and `CONTACT_*` are empty vars here, so a
  deployed Worker refuses every admin request until session 07 sets them. The postal address in
  DESIGN §11 is not copied into the config.
- Admin auth is tested only against tokens signed locally. The real Access JWT shape (`common_name`
  on service tokens, `aud` as an array) follows Cloudflare's docs and is **unverified** until
  staging (session 07).
- The certs cache is per isolate, so each new isolate fetches the certs once.
- `GET /api/events` is unpaginated and the response schema caps it at 1,000 events, so the list
  would return a 500 past that. At about four events a month that is decades away; paginate it
  (session 14 or later) well before then.
