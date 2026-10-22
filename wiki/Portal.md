# Portal

The guest web portal: one Cloudflare Worker in `apps/portal`. The behaviour spec is
[portal/DESIGN.md](./portal/DESIGN.md) and the build plan is [portal/README.md](./portal/README.md).
This page records *why* the code is shaped the way it is, and is extended as each session lands.

**Status (session 02):** the scaffold only. It routes by host, serves two placeholder SPAs, and
has the headers, error shape, logging, tests and CI. There is no D1 schema, auth or API yet.
**Nothing here has run on real Cloudflare.** It is verified with Vitest in workerd, `wrangler dev`
and `wrangler deploy --dry-run` only.

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
  (DESIGN §4.1). The comparison is lowercase and **includes the port** as written in the var.

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
- `onError`: `AppError` keeps its own status and code, zod errors become 400 `invalid_request`,
  Hono `HTTPException` keeps its status with a generic message, and anything else is a 500
  `internal_error`. The zod issues and the original message are **not** returned or logged, because they can
  contain request data.
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
`bun run build` runs `wrangler deploy --dry-run` for all three, so a typo in any block fails CI. Don't
deploy the top level: its hosts are localhost. `worker-configuration.d.ts` is generated by
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
  with the real local bindings. They cover host routing, headers on every kind of response, error
  mapping, logger redaction and the SPA serving rules. SPA serving is tested against a fake `ASSETS`
  binding so the Worker tests don't depend on a previous build. The real `dist/` was checked by hand
  through `wrangler dev` (headers, caching, host separation).
- **SPAs** (`src/web/**`): `bun test` with happy-dom, loaded through `bunfig.toml`. Vitest and
  `bun test` each ignore the other's files (`include` in `vitest.config.ts`, and `bun test src/web`).
- Vitest 4 is used (the plugin supports 4.1+ and 5). There is no Testing Library: the placeholder
  tests need only `createRoot`, and DESIGN §5 doesn't list it.

## Known limits

- The health version is the `package.json` version. A git SHA arrives with the deploy workflow in session 07.
- The rate-limit bindings are declared but unused, and their thresholds are placeholders.
- `ADMIN_EMAILS`, `ACCESS_*` and `CONTACT_*` are empty vars here. Later sessions fill or read them. The
  postal address in DESIGN §11 is not copied into the config.
