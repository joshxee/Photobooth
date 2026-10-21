# Photobooth Portal: MVP Solution Design (v2.0)

Status: **accepted** (decisions final; spike results pending), no implementation yet.
Implementation plan: [README.md](./README.md) in this folder. This replaces *Photobooth Portal MVP Solution v1.2*
(PDF). v1.2's goals still hold: live delivery, private media, no lost captures, NZ operations,
roughly USD 20 a month. v2.0 keeps those goals and removes machinery that was sized for a much
larger operation than 2 admins, 5 booths and 20 events a month. Section 18 lists every v1.2
element that was removed, with the reason.

---

## 1. Summary

Booth tablets upload each completed shot to a single Cloudflare Worker while the event is
running. The Worker:

- checks the device and event,
- streams the bytes into private R2 storage with an integrity check,
- re-encodes three fixed variants with the Images binding, with all metadata removed,
- marks the photo READY in D1, all inside the same request.

Guests scan a QR code on the booth's post-shoot screen and get a private event gallery that
updates live. Admins manage events, devices and moderation behind Cloudflare Access.

**Live from day 1 is the product differentiator.** Every simplification below keeps it.

| | |
|---|---|
| Runtime | 1 Worker (Hono): HTTP requests plus a daily scheduled job |
| Data | 1 D1 database, 1 private R2 bucket, Images binding |
| Hostnames | `photos.<domain>` (guests and devices), `admin.<domain>` (Access-protected) |
| Booth changes | Durable outbox, device enrolment, event selection, gallery QR, upload status |
| Repo | `apps/portal` next to `apps/booth`. No shared workspace, booth toolchain untouched |
| Base cost | about USD 20/month (10,000 photos/month, 90-day retention) |
| Effort | 16–22 engineering days, including a 1–2 day spike |

## 2. Scope

**In scope:**
- single-image galleries (each shot is its own photo)
- live updates by polling
- full-resolution download of the sanitised copy
- admin event, device and moderation management
- 90-day retention
- link rotation
- device revocation
- audit log

**Out of scope:**
- strips or composites in the gallery (we store `session_id` and `shot` so they can be added later)
- guest passcodes
- guest uploads
- accounts and payments
- multi-tenancy
- video and GIF
- ZIP downloads
- websockets
- retention extension and reminder emails
- printing
- exact-original archival (the SD card is the archive)

## 3. Key decisions

| # | Decision | Why | Revisit when |
|---|---|---|---|
| D1 | **The camera's SD card stays the archive; the booth's disk is only a transit buffer.** The camera keeps running in *Still Img. Save Dest. = PC+Camera*. A shot is written to the booth's app-private outbox and deleted as soon as the server confirms READY. | The current "photos never touch disk" rule exists because the SD card already archives every shot. Live upload needs to survive crashes and outages, so the rule becomes "**nothing is kept on the booth after the server confirms it**". | Booths run without an SD card |
| D2 | **Single images only** | Strips are laid out in the web view, not stored as images | Product wants strip downloads |
| D3 | **Only completed sessions upload** (confirmed). Shots from a cancelled session are not queued. | A guest who cancels did not consent to sharing. The SD card still has the shots. | Product feedback |
| D4 | **Bytes go through the Worker** behind a Worker-signed upload URL (section 9) | No storage credentials exist anywhere, integrity is checked in-path, and the result is synchronous | See section 9.4 |
| D5 | **Processing happens inside the upload request** | Upload success equals READY, so no queue, lease or reconciler is needed. The booth's outbox is the retry queue. | Processing p95 is too slow (spike) or files are large |
| D6 | **One bucket**: `incoming/` and `events/` prefixes | Fewer resources. Lifecycle rule on `incoming/` | Need for separate credentials or replication |
| D7 | **One Worker, two hostnames** | Separate cookies for admin and gallery with one deployment | Teams or permissions diverge |
| D8 | **Admin-issued one-time enrolment code** for devices | 5 owned tablets; no pairing handshake | Self-service booths |
| D9 | **The share token is stored retrievably** (confirmed; not hash-only, unlike v1.2) | The booth must show the event QR, and admins must be able to reprint it. Rotation still invalidates old links. | Per-guest identity |
| D10 | **Stateless signed guest cookie**; no session table | The event row already carries `access_version`, so revocation stays immediate | Per-session analytics or revocation |
| D11 | **No cache layer**: serve from R2 after the access check | Well under included R2 reads; no egress charges | Gallery read volume grows about 50× |
| D12 | **Recovery = D1 Time Travel + SD card + 7-day soft delete of events** | Fewest moving parts | Need for independent backup |
| D13 | **Contract = zod (TypeScript) + serde (Rust), pinned by shared JSON fixtures** | Private API; no OpenAPI tooling | A third-party client appears |

## 4. Architecture

```
 Booth tablet (Tauri, Android)                       Cloudflare
 ┌──────────────────────────────┐   HTTPS   ┌──────────────────────────────────────┐
 │ session → outbox (disk)      │──────────►│ Worker (Hono)  photos.<domain>       │
 │ upload loop (Rust, reqwest)  │           │   /v1/device/*   device bearer       │
 │ post-shoot QR                │           │   /e/{publicId}/* guest cookie       │
 └──────────────────────────────┘           │   SPA assets (gallery)               │
 Guest phone ── gallery SPA ───────────────►│                                      │
 Admin browser ── Access ── admin SPA ─────►│ Worker  admin.<domain>  Access JWT   │
                                            │ scheduled(): retention / purge       │
                                            └──┬──────────┬───────────┬────────────┘
                                               │D1        │R2 bucket  │Images binding
```

The Worker routes on the `Host` header, and an unknown host returns 404. `workers.dev` and preview
URLs are **disabled** in production, so Access cannot be bypassed through an alternate hostname.

### 4.1 Account, domain and environments

**Account.** Use one Cloudflare account **dedicated to the business**, not a personal or shared
one. Separate accounts for staging and production are standard for larger organisations, but
for a startup they double the setup (billing, Access team, API tokens) for little isolation
benefit. Staging's synthetic traffic barely touches the free allowances.
- Enable 2FA for every member.
- Invite the second admin as a member rather than sharing a login.
- Create one scoped API token for CI: Workers Scripts, D1, R2 and Workers Routes for this account
  and zone only. It lives only in GitHub environment secrets (`staging`, `production`), and the
  `production` environment requires your approval.
- **Agents never hold a write token.** Cloudflare API permissions for Workers and D1 are
  account-wide, so a "staging-only" token would not actually be limited to staging.
  - Agents deploy staging by triggering the `deploy-staging` workflow.
  - Locally they use a **read-only** token (Workers observability, D1 read, R2 read) for logs
    and inspection.
- The current personal account is used only for the throwaway spike (session 01). Its
  resources are deleted afterwards.
- Set billing notifications as in section 15.

**Domain.** The domain will most likely be a **`.co.nz`**, not yet registered. Register it
before the first event and run its DNS on Cloudflare (the Free zone plan is enough).
- Cloudflare Registrar does not sell `.nz` domains at the time of writing (check when buying).
  Register with an InternetNZ-authorised registrar, then add the domain to Cloudflare and change
  its nameservers to the two Cloudflare gives you.
- Enable DNSSEC in Cloudflare, then add the DS record at the registrar. `.nz` supports DNSSEC.
- Turn on registrar lock and auto-renew, and use a business-owned email as the registrant
  contact.
- Allow up to 24 hours for the nameserver change before the staging Access app and routes can
  be created. Do this at least a week before the pilot event.
- **The design does not depend on the TLD.** Hostnames are Wrangler variables (`GALLERY_HOST`,
  `ADMIN_HOST`) and routes, and nothing in code or the booth hard-codes a domain. The booth's
  portal URL is an operator setting with a build-time default for each environment. Choosing `.com` instead changes only where you register
  it.

**Hostnames and environments** (`wrangler.jsonc` environments, one codebase):

| | Production | Staging |
|---|---|---|
| Guest + device host | `photos.<domain>` | `photos-staging.<domain>` |
| Admin host | `admin.<domain>` (Access app) | `admin-staging.<domain>` (separate Access app) |
| Worker | `portal` | `portal-staging` |
| D1 / R2 | `portal` / `portal-media` | `portal-staging` / `portal-media-staging` |
| Secrets | `UPLOAD_KEY`, `SESSION_KEY` (unique per env) | separate values |
| Deploy | CI, on your approval | CI, automatically on `main` or on demand for a branch |

- Staging uses synthetic photos only, and booths enrol against staging with a build-time
  setting.
- `admin-staging` is behind its own Access app. `photos-staging` cannot sit behind Access,
  because booths are not browsers. It holds only synthetic photos, and its galleries still need
  the share token.
- `workers.dev` and preview URLs are disabled in both environments.
- Until the domain exists, local development uses `wrangler dev`. Staging can't use Access
  without a zone, so the spike runs against `wrangler dev` with `--remote` bindings.
- **No per-PR Previews in MVP.** Workers Previews would give each branch its own Worker, but
  this Worker routes on two hostnames, and Previews do not run cron triggers. Revisit if agents
  need a parallel environment for each branch.
- **Agent access to staging admin**: an Access *service token*. Staging's Worker accepts its
  JWT (`common_name` claim) when the token's client ID is listed in `ADMIN_SERVICE_CLIENTS`.
  The production list is empty.

## 5. Repository layout and dependencies

```
apps/booth/                  (existing; Rust + React; unchanged toolchain)
apps/portal/
  package.json               deps: hono, zod, react, react-dom
                             dev:  wrangler, @cloudflare/workers-types, typescript, @types/react(-dom),
                                   vitest, @cloudflare/vitest-plugin, happy-dom test helpers
  wrangler.jsonc             bindings, envs (staging, production), cron, assets
  migrations/0001_init.sql
  build.ts                   bun build → dist/admin, dist/gallery (two SPA entry points)
  src/shared/                zod schemas + inferred types (single source of the contract)
  src/worker/                routes/, domain/ (pure policy, signing), db/ (prepared SQL)
  src/web/admin/, src/web/gallery/, src/web/ui/
  contract/fixtures/*.json   request/response examples, used by both bun test and cargo test
crates/photobooth-core/      + outbox module (pure, transport behind a trait)
apps/booth/src-tauri/        + portal HTTP client (reqwest, rustls), enrolment, event selection
```

- **No root Bun workspace.** Each app keeps its own `bun.lock`, as `apps/booth` does today.
  The booth frontend does not import the portal's schemas, because uploads run in Rust and the
  UI only sees IPC types.
- **No router, query or state libraries** in the portal. Two small SPAs: the gallery is one view
  plus a lightbox, and admin has about five views over a small `history` wrapper.
- The Geist fonts are copied into the portal rather than imported across apps.
- New Rust dependencies: `reqwest` with rustls, which is already in `Cargo.lock` indirectly, and
  `qrcode`. `sha2` and `uuid` are already in the lockfile.

## 6. Data model (D1)

```sql
events(
  id TEXT PK, public_id TEXT UNIQUE,            -- public_id: 16 random base32 chars, in URLs
  name, venue, timezone,                        -- IANA zone
  starts_at, ends_at,                           -- UTC
  upload_status TEXT,                           -- DRAFT | OPEN | CLOSED
  gallery_status TEXT,                          -- HIDDEN | LIVE | SUSPENDED
  share_token TEXT, access_version INTEGER,     -- rotation: new token, access_version+1
  photo_limit INTEGER DEFAULT 2000,
  retention_until,                              -- ends_at + 90 d (stored for future extension)
  deleted_at, purge_after,                      -- soft delete; purge_after = deleted_at + 7 d
  created_at, updated_at)

devices(
  id TEXT PK, name,
  token_hash TEXT UNIQUE,                       -- SHA-256 of 256-bit bearer credential
  enrol_code_hash, enrol_expires_at,            -- one-time, 10 min
  enrolled_at, revoked_at,
  last_seen_at, last_backlog INTEGER, app_version)

photos(
  id TEXT PK, event_id FK, device_id FK,
  client_photo_id TEXT, session_id TEXT, shot INTEGER,
  captured_at, bytes INTEGER, sha256 TEXT,
  state TEXT,                                   -- PENDING | READY | REJECTED
  reject_reason, hidden INTEGER DEFAULT 0,
  width, height, variant_bytes TEXT,            -- JSON {thumb, preview, full}
  published_at, created_at,
  UNIQUE(device_id, client_photo_id))
INDEX photos(event_id, state, hidden, published_at, id)
INDEX photos(event_id, session_id)

audit(id, at, actor, action, event_id, target_id, detail)   -- INDEX(event_id, at), INDEX(at)
```

- The photo limit is enforced atomically in the insert itself:
  `INSERT … SELECT … WHERE (SELECT COUNT(*) FROM photos WHERE event_id=?) < photo_limit`.
  A single statement is atomic on D1, so no reservation or reconcile step is needed.
- Admins come from the Worker variable `ADMIN_EMAILS` plus the Access policy. There is no
  admins table.
- Migrations are additive only, applied with `wrangler d1 migrations apply`.

## 7. Storage layout and lifecycle (one private bucket)

| Key | Written | Removed |
|---|---|---|
| `incoming/{photoId}.jpg` | upload PUT | right after READY or REJECTED; lifecycle rule deletes the prefix after 1 day as a backstop |
| `events/{eventId}/{photoId}/{thumb\|preview\|full}.jpg` | processing | single-photo delete, or event purge (prefix delete) |

Keys are fixed per photo, so reprocessing overwrites identical outputs. That replaces v1.2's
publication versions and fencing. No public bucket URLs or custom domains are used.

| Variant | Output |
|---|---|
| thumb | JPEG, fit 480×480, quality 75 |
| preview | JPEG, fit 1600×1600, quality 85 |
| full | JPEG, original dimensions, orientation normalised, quality 92 |

All variants use `metadata=none`, which a GPS-EXIF fixture verifies as a release gate.

## 8. API

All bodies are JSON validated by zod, unknown fields are rejected, and body sizes are capped.
Errors look like `{code, message, correlationId}`.

**Device** (`photos.<domain>`, `Authorization: Bearer <device credential>`, except enrolment):

| Route | Purpose |
|---|---|
| `POST /v1/device/enrol` `{code, name, appVersion}` | Swap the one-time code for a credential (returned once). Rate-limited per IP. |
| `GET /v1/device/events` | OPEN events: id, name, venue, local date, timezone |
| `GET /v1/device/events/{id}` | Event detail plus `galleryUrl` (with token) when the gallery is LIVE, for the post-shoot QR |
| `POST /v1/device/photos` | Upload intent (section 9). Idempotent on `clientPhotoId`. |
| `PUT /v1/device/uploads/{photoId}?exp&sig` | Upload and process (section 9). Authorised by the signed URL. |

Every device call sends an `X-Outbox-Depth` header, and the server records `last_seen_at`,
`last_backlog` and `app_version`. That gives admins live visibility into each booth at no extra
cost.

**Guest** (`photos.<domain>`; cookie scoped to `Path=/e/{publicId}`):

| Route | Purpose |
|---|---|
| `GET /e/{publicId}` | Gallery SPA. The link is `/e/{publicId}#k={shareToken}[&s={sessionId}]` |
| `POST /e/{publicId}/api/session` `{token}` | Swap the token for a cookie. Rate-limited. |
| `GET /e/{publicId}/api/photos?cursor&session` | READY, non-hidden photos, newest first; 24 per page, max 100 |
| `GET /e/{publicId}/m/{photoId}/{variant}` | Media, served after the access check. `?download=1` sets `attachment` |

**Admin** (`admin.<domain>`; Access JWT plus the email allowlist; mutations need a same-origin
`Origin` and a JSON content type):

- Events: list, create, update, open, close, publish, suspend, rotate link, delete (7-day undo), restore.
- Photos: list by state, hide, unhide, delete (immediate hard delete); media proxy.
- Devices: create (returns the enrolment code), revoke, list with last seen, backlog and version.
- Audit list.

## 9. Upload and processing

### 9.1 Flow

```
Booth                         Worker                                   D1 / R2 / Images
1 POST /v1/device/photos {eventId, clientPhotoId, sessionId, shot, capturedAt, bytes, sha256}
                              device active? event OPEN, not deleted?
                              INSERT-if-under-limit … ON CONFLICT(device_id, client_photo_id)
   ◄── READY  → done (nothing to upload)
   ◄── PENDING + upload {method:PUT, url (HMAC, exp 15 min), headers, expiresAt}
   ◄── 409 mismatch (same clientPhotoId, different hash or event) / event_closed / limit
2 PUT upload.url   (body = JPEG, exact Content-Length, Content-Type image/jpeg)
                              verify sig/exp; photo PENDING; device not revoked; event not deleted
                              R2.put(incoming/{id}, body, {sha256})  ── R2 checks integrity
                              Images.info → JPEG? dimensions ≤ limit? else REJECTED (422)
                              3 × transform(metadata=none) → R2.put(events/…/{variant})
                              UPDATE photos SET state='READY' … WHERE id=? AND state='PENDING'
                                     AND event not deleted
                              delete incoming/{id}
   ◄── 201 READY   |  202 PENDING (re-POST later)  |  4xx/5xx
3 delete local file + record
```

### 9.2 Why this is correct without leases, attempts or a queue

- **Idempotency.** `UNIQUE(device_id, client_photo_id)` means retries never create a second
  photo. A retried PUT re-runs processing and overwrites identical deterministic keys.
- **Concurrent duplicate PUTs.** Both write the same bytes. The conditional UPDATE succeeds once
  and the other request re-reads READY.
- **Integrity.** R2 rejects the write if the bytes do not match the declared SHA-256. If the
  spike shows that the binding's `sha256` option cannot do this, the fallback is
  `crypto.DigestStream` in the Worker, which streams the hash without buffering.
- **Partial failure.** If variants are written but the UPDATE does not run, the photo stays
  PENDING and the booth retries. Late writes into a deleted event can't publish because the
  UPDATE checks the event. Any stray objects are removed by the purge's prefix delete 7 days
  later.
- **Closing uploads** blocks new intents only. A photo whose intent was accepted can still
  finish its PUT, so closing never strands in-flight work.
- The 202 response exists so the client contract already supports asynchronous processing
  (section 9.4). The MVP returns it only if the request can't finish in time.

### 9.3 Error handling on the booth

| Response | Booth behaviour |
|---|---|
| Network error, 429, 5xx, 202 | Retry with jittered exponential backoff (1 s → 5 min cap), honouring `Retry-After` |
| Upload URL expired | Re-POST the intent (same `clientPhotoId`) for a fresh URL |
| 422 hash mismatch | Retry at most 3 times, then needs attention |
| 401/403 (revoked), 409 event_closed or limit, 422 invalid image | **Needs attention**: the file is kept and shown to the operator; no automatic retry |

### 9.4 Upload through the Worker: is it best practice, and will we have to change it?

**What Cloudflare documents.** Both patterns are documented and supported:

- *Worker binding upload*: the Worker receives the