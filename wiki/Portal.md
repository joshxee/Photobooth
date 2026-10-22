# Portal

The guest web portal: one Cloudflare Worker in `apps/portal`. The behaviour spec is
[portal/DESIGN.md](./portal/DESIGN.md) and the build plan is [portal/README.md](./portal/README.md).
This page records *why* the code is shaped the way it is, and is extended as each session lands.

**Status (session 03):** the scaffold (02) plus the D1 schema, the data layer, the pure domain
rules and the shared contract (zod schemas and JSON fixtures). It routes by host and serves two
placeholder SPAs; there is no auth or API route yet. **Nothing here has run on real Cloudflare.**
It is verified with Vitest in workerd (local D1), `wrangler dev`, `wrangler d1 … --local` and
`wrangler deploy --dry-run` only.

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
  | `unauthorized` | 401 | Revoked or unknown credential: needs attention |
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
- The rate-limit bindings are declared but unused, and their thresholds are placeholders.
- `ADMIN_EMAILS`, `ACCESS_*` and `CONTACT_*` are empty vars here. Later sessions fill or read them. The
  postal address in DESIGN §11 is not copied into the config.
