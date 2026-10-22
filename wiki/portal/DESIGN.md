# Photobooth Portal: MVP Solution Design (v2.1)

Status: **accepted**, no implementation yet. v2.1 applies the spike results
([spike/RESULTS.md](./spike/RESULTS.md)): the booth makes the variants (D14), the Worker stores and
checks them, and the target volume is 2,000 photos a month. **D14 was confirmed by the user on
2026-10-22** (PROGRESS.md, sessions 01 and 01b).
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
- streams each variant the booth made (a thumbnail and an HD copy, with all metadata already
  removed) into private R2 storage with an integrity check,
- checks the JPEG headers (no metadata segments, the declared dimensions) without decoding,
- marks the photo READY in D1 once both variants are stored, inside the request that stores the
  second one.

Guests scan a QR code on the booth's post-shoot screen and get a private event gallery that
updates live. Admins manage events, devices and moderation behind Cloudflare Access.

**Live from day 1 is the product differentiator.** Every simplification below keeps it.

| | |
|---|---|
| Runtime | 1 Worker (Hono): HTTP requests plus a daily scheduled job |
| Data | 1 D1 database, 1 private R2 bucket (no Images binding, see D14) |
| Hostnames | `photos.<domain>` (guests and devices), `admin.<domain>` (Access-protected) |
| Booth changes | Variant encoding, durable outbox, device enrolment, event selection, gallery QR, upload status |
| Repo | `apps/portal` next to `apps/booth`. No shared workspace, booth toolchain untouched |
| Base cost | USD 0/month of Cloudflare usage on Workers Free (2,000 photos/month; photos are kept until deleted, so storage grows about 0.9 GB a month), about USD 1.50/month all-in with the domain; USD 5 more if the account moves to Workers Paid for request headroom (section 16). Budget: USD 20/month all-in |
| Effort | 17–24 engineering days, including the spike and 1–2 days for the booth's variant encoder (D14) |

## 2. Scope

**In scope:**
- single-image galleries (each shot is its own photo)
- live updates by polling
- HD download (2560 px long edge) of the sanitised copy. The full-resolution original stays on the
  camera's SD card
- admin event, device and moderation management
- uploads close 90 days after the event ends; photos stay viewable until an admin deletes the
  event (D15)
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
| D1 | **The camera's SD card stays the archive; the booth's disk is only a transit buffer.** The camera keeps running in *Still Img. Save Dest. = PC+Camera*. A shot's two variants (D14) are written to the booth's app-private outbox and deleted as soon as the server confirms READY. | The current "photos never touch disk" rule exists because the SD card already archives every shot. Live upload needs to survive crashes and outages, so the rule becomes "**nothing is kept on the booth after the server confirms it**". | Booths run without an SD card |
| D2 | **Single images only** | Strips are laid out in the web view, not stored as images | Product wants strip downloads |
| D3 | **Only completed sessions upload** (confirmed). Shots from a cancelled session are not queued. | A guest who cancels did not consent to sharing. The SD card still has the shots. | Product feedback |
| D4 | **Bytes go through the Worker** behind a Worker-signed upload URL per variant (section 9) | No storage credentials exist anywhere, integrity is checked in-path (spike Q1: R2 rejects a wrong `sha256`), and the result is synchronous | See section 9.4 |
| D5 | **Validation happens inside the upload request**: a sha256 put, a 64 KB range read and a JPEG header walk; no decoding | A stored variant is a checked variant, and storing the second variant makes the photo READY, so no queue, lease or reconciler is needed. The booth's outbox is the retry queue. About 1 ms CPU per request (spike Q11) | Uploads come from devices we don't own |
| D6 | **One bucket**, `events/` prefix only | Variants go straight to their final keys, so there is no `incoming/` prefix or lifecycle rule | Need for separate credentials or replication |
| D7 | **One Worker, two hostnames** | Separate cookies for admin and gallery with one deployment | Teams or permissions diverge |
| D8 | **Admin-issued one-time enrolment code** for devices | 5 owned tablets; no pairing handshake | Self-service booths |
| D9 | **The share token is stored retrievably** (confirmed; not hash-only, unlike v1.2) | The booth must show the event QR, and admins must be able to reprint it. Rotation still invalidates old links. | Per-guest identity |
| D10 | **Stateless signed guest cookie**; no session table | The event row already carries `access_version`, so revocation stays immediate | Per-session analytics or revocation |
| D11 | **No cache layer**: serve from R2 after the access check | Well under included R2 reads; no egress charges | Gallery read volume grows about 50× |
| D12 | **Recovery = D1 Time Travel + SD card + 7-day soft delete of events** | Fewest moving parts | Need for independent backup |
| D13 | **Contract = zod (TypeScript) + serde (Rust), pinned by shared JSON fixtures** | Private API; no OpenAPI tooling | A third-party client appears |
| D15 | **Uploads stop 90 days after the event ends; the photos and the gallery stay** until an admin deletes the event (7-day undo, then purged). No automatic photo expiry in the MVP. **Decided by the user on 2026-10-22** (session 03), replacing the 90-day deletion of published variants. | Events run once, and early on we'd rather be generous about when guests can retrieve photos. The 90-day mark only guards against a stale booth uploading into an old event. Storage grows about 0.9 GB a month, still free up to 10 GB and then USD 0.015 per GB-month (§16) | Storage cost matters, a privacy review asks for a fixed retention, or galleries need a lifetime |
| D14 | **The booth makes the variants** (thumb 480 px q75, HD 2560 px q85, orientation applied, no metadata) in Rust; the Worker never decodes (spike Q10, option B). **Confirmed by the user on 2026-10-22.** | The Images binding keeps GPS and serial numbers whatever `metadata` is set to (Q6). It also needs Workers Paid for CPU (355–470 ms per photo against the Free 10 ms, Q11) and caps inputs at 20,000,000 bytes (Q3). Uploading 0.25–0.62 MB instead of 11–17 MB per shot is 28–44× less traffic on venue networks. Trade-off: guests' browsers decode the booth's JPEG rather than a Cloudflare re-encode. Uploads come only from enrolled, revocable devices, and the header walk limits what is stored (RESULTS.md, Q10) | Uploads from devices we don't own, or on-tablet encoding is too slow (measured in session 08b: p50 0.42 s, p95 0.54 s per Sony shot on the tablet, against a 3 s gate) |

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
                                            │ scheduled(): purge / audit prune     │
                                            └──┬──────────┬───────────┬────────────┘
                                               │D1        │R2 bucket
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
  without a zone. (The spike instead deployed a throwaway Worker to the personal account's
  `workers.dev`, then deleted it.)
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
crates/photobooth-core/      + outbox module (pure, transport behind a trait), variant encoding
                             (decode, EXIF orientation, resize, JPEG encode without metadata)
apps/booth/src-tauri/        + portal HTTP client (reqwest, rustls), enrolment, event selection
```

- **No root Bun workspace.** Each app keeps its own `bun.lock`, as `apps/booth` does today.
  The booth frontend does not import the portal's schemas, because uploads run in Rust and the
  UI only sees IPC types.
- **No router, query or state libraries** in the portal. Two small SPAs: the gallery is one view
  plus a lightbox, and admin has about five views over a small `history` wrapper.
- The Geist fonts are copied into the portal rather than imported across apps.
- New Rust dependencies: `reqwest` with rustls, which is already in `Cargo.lock` indirectly, and
  `qrcode`. `sha2` and `uuid` are already in the lockfile. D14 adds one JPEG decode, resize and
  encode stack (for example `zune-jpeg` + `fast_image_resize` + `jpeg-encoder`, or `turbojpeg`),
  chosen and measured on the tablet by the booth session that builds it.

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
  uploads_until,                                -- ends_at + 90 d: uploads stop, the gallery stays (D15)
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
  captured_at,
  thumb_sha256 TEXT, hd_sha256 TEXT,            -- declared in the intent (D14)
  thumb_stored INTEGER DEFAULT 0, hd_stored INTEGER DEFAULT 0,
  state TEXT,                                   -- PENDING | READY | REJECTED
  reject_reason, hidden INTEGER DEFAULT 0,
  width, height, variant_bytes TEXT,            -- HD size, orientation applied; JSON {thumb, hd}
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
- Refinements made when the schema was written (session 03, `apps/portal/migrations/0001_init.sql`):
  - `retention_until` is named `uploads_until`, because it only closes uploads (D15).
  - IDs are UUIDv7 (time-ordered). Times are exactly `toISOString()` text (UTC, milliseconds),
    because SQL compares them as text; the API schemas accept only that form.
  - `NOT NULL` on every column that always has a value: all of `events` except `deleted_at` and
    `purge_after` (`venue` defaults to `''`, `access_version` to 1); `devices.name`; all of
    `photos` except `reject_reason` and `published_at`; `audit.at`, `actor` and `action`.
  - `CHECK`s beyond the status enums: `ends_at >= starts_at`; `deleted_at` and `purge_after` set
    together; `enrol_code_hash` and `enrol_expires_at` set together; `token_hash` and
    `enrolled_at` set together; READY needs both `*_stored` flags and `published_at`; REJECTED
    needs `reject_reason`; sha256 columns are 64 lowercase hex; flags are 0/1; `shot`,
    `last_backlog` and `photo_limit` ≥ 0, `access_version` ≥ 1, `width`/`height` > 0;
    `variant_bytes` and `audit.detail` are valid JSON.
  - `devices.enrol_code_hash` is `UNIQUE`, because enrolment looks the device up by the code's hash.
  - `photos.event_id` is `ON DELETE CASCADE`, so purging an event row removes its photo rows.
    `audit` has no foreign key, so it outlives the event it describes.
  - Index names: `photos_gallery`, `photos_session`, `audit_event_at`, `audit_at`.

## 7. Storage layout and lifecycle (one private bucket)

| Key | Written | Removed |
|---|---|---|
| `events/{eventId}/{photoId}/{thumb\|hd}.jpg` | the variant's upload PUT | single-photo delete, or event purge (prefix delete). A variant that fails the header check is deleted at once |

Keys are fixed per photo, so a retried upload overwrites the same object. That replaces v1.2's
publication versions and fencing. No public bucket URLs or custom domains are used. Media is
served with `Cache-Control: private, max-age=31536000, immutable`, because a key never changes
content (this keeps guest traffic inside the Workers Free request limit, spike Q12).

| Variant | Made by the booth (D14) | Measured size (spike Q7) |
|---|---|---|
| thumb | JPEG, fit 480×480, quality 75 | 14–30 KB |
| hd | JPEG, fit 2560×2560, quality 85, orientation applied | 240–585 KB (mean 416 KB) |

The gallery grid uses `thumb`; the lightbox and the download use `hd`. Neither variant carries
metadata: the booth encodes baseline JPEG without EXIF, XMP, IPTC or ICC (the camera must shoot
sRGB), and the Worker's header check (section 9.1) rejects any APP1, APP2, APP13 or COM segment,
a non-baseline frame, or an object that doesn't end in EOI. A fixture with GPS and serial-number EXIF verifies
this as a release gate, on both the booth's encoder and the Worker's check. (The Images binding
was dropped because it keeps that EXIF whatever `metadata` is set to; spike Q6.)

## 8. API

All bodies are JSON validated by zod, unknown fields are rejected, and body sizes are capped.
Errors look like `{code, message, correlationId}`; `code` comes from a closed set with one HTTP
status per code (`apps/portal/src/shared/schemas.ts`, listed in `wiki/Portal.md`).

**Device** (`photos.<domain>`, `Authorization: Bearer <device credential>`, except enrolment):

| Route | Purpose |
|---|---|
| `POST /v1/device/enrol` `{code, name, appVersion}` | Swap the one-time code for a credential (returned once). Rate-limited per IP. |
| `GET /v1/device/events` | OPEN events: id, name, venue, local date, timezone |
| `GET /v1/device/events/{id}` | Event detail plus `galleryUrl` (with token) when the gallery is LIVE, for the post-shoot QR |
| `POST /v1/device/photos` | Upload intent (section 9). Idempotent on `clientPhotoId`. |
| `PUT /v1/device/uploads/{photoId}/{variant}?exp&sig` | Upload and check one variant (section 9). Authorised by the signed URL. |

Every authenticated device call sends `X-Outbox-Depth` and `X-App-Version` headers, and the
server records `last_seen_at`, `last_backlog` and `app_version`, at most once a minute per device to
save D1 writes. That gives admins live visibility into each booth at no extra cost. (Session 05
named the app-version header, `DEVICE_HEADERS` in `src/shared/schemas.ts`. The event detail serves
any event that isn't deleted, and reports an OPEN event past `uploads_until` as CLOSED.)

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
Booth                         Worker                                   D1 / R2
0 after the session completes: decode, apply EXIF orientation, encode thumb + hd without
  metadata (D14); the outbox stores the two variants, not the original
1 POST /v1/device/photos {eventId, clientPhotoId, sessionId, shot, capturedAt, width, height,
                          variants: {thumb: {bytes, sha256}, hd: {bytes, sha256}}}
                              device active? event OPEN, not deleted, before uploads_until? thumb ≤ 200 KB,
                                     hd ≤ 3 MB and ≤ 2560 px?
                              INSERT-if-under-limit … ON CONFLICT(device_id, client_photo_id)
   ◄── READY  → done (nothing to upload)
   ◄── PENDING + uploads {thumb, hd: {method:PUT, url (HMAC, exp 15 min), headers, expiresAt}}
       (only the variants not yet stored)
   ◄── 409 mismatch (same clientPhotoId, different hashes or event) / event_closed / limit
2 PUT uploads.<variant>.url   (body = JPEG, exact Content-Length, Content-Type image/jpeg)
                              verify sig/exp; photo PENDING; device not revoked; event not deleted
                              R2.put(events/…/{variant}.jpg, body, {sha256}) ── R2 checks
                                     integrity (throws 10037 → 422 hash_mismatch)
                              R2.get(range 0–64 KB) → header walk: SOI, allowed segments only
                                     (APP0, APP14, DQT, DHT, DRI, SOF0 baseline), SOF size =
                                     declared size for hd / ≤ 480 px for thumb, SOS within 64 KB;
                                     R2.get(last 2 bytes) = EOI;
                                     else delete the object, REJECTED (422 invalid_image)
                              UPDATE photos SET <variant>_stored=1 … ;
                              UPDATE photos SET state='READY' … WHERE id=? AND state='PENDING'
                                     AND thumb_stored AND hd_stored AND event not deleted
   ◄── 201 READY (second variant)  |  200 STORED (first variant)  |  4xx/5xx
3 delete the local variants + record on READY
```

Spike numbers for step 2 (RESULTS.md): about 1 ms CPU per request, wall time p50 334 ms /
p95 449 ms for HD from Auckland. The DigestStream fallback is not needed. The header walk proves
there is no metadata before the (single, baseline) scan and that the object ends in EOI. It does
not parse the entropy-coded data, so a crafted file from a stolen, unrevoked tablet is the
residual risk (section 13).

### 9.2 Why this is correct without leases, attempts or a queue

- **Idempotency.** `UNIQUE(device_id, client_photo_id)` means retries never create a second
  photo. A retried PUT overwrites the same key with the same bytes (the hash is fixed by the
  intent).
- **Concurrent duplicate PUTs.** Both write the same bytes. The conditional UPDATE succeeds once
  and the other request re-reads READY.
- **Integrity.** R2 rejects the write if the bytes do not match the declared SHA-256 (verified by
  the spike, Q1: `put` throws error 10037 and stores nothing, also for a truncated body). The
  request body is streamed, not buffered (Q2: 0–1 ms CPU for 17 MB).
- **Partial failure.** If one variant is stored but not the other, or the UPDATE does not run,
  the photo stays PENDING. The booth re-POSTs the intent and gets URLs only for what is missing.
  Late writes into a deleted event can't publish because the UPDATE checks the event. Any stray
  objects are removed by the purge's prefix delete 7 days later.
- **Closing uploads** blocks new intents only. A photo whose intent was accepted can still
  finish its PUT, so closing never strands in-flight work.
- `200 STORED` means "this variant is stored, the photo is not READY yet". With D14 the
  request does no processing, so the MVP never returns 202. The booth still treats 202 like a
  retryable response, so a later asynchronous path (section 9.4) needs no app release.

### 9.3 Error handling on the booth

| Response | Booth behaviour |
|---|---|
| 200 STORED | Upload the other variant if it is still pending; keep the record until READY |
| Network error, 429, 5xx, 202 | Retry with jittered exponential backoff (1 s → 5 min cap), honouring `Retry-After` |
| Upload URL expired | Re-POST the intent (same `clientPhotoId`) for a fresh URL |
| 422 hash mismatch | Retry at most 3 times, then needs attention |
| 401/403 (revoked), 409 event_closed or limit, 422 invalid image | **Needs attention**: the variants are kept and shown to the operator; no automatic retry. A 422 invalid image from the booth's own encoder is a booth bug |

### 9.4 Upload through the Worker: is it best practice, and will we have to change it?

> **v2.1 (spike 01).** With D14 the bodies are 0.25–0.62 MB variants and the request does no
> processing, so the "through the Worker" verdict below is even stronger. The "20 MB" figures
> now mean the per-variant caps (section 9.1), and condition 3 below no longer applies.

**What Cloudflare documents.** Both patterns are documented and supported:

- *Worker binding upload*: the Worker receives the body and calls `env.BUCKET.put`.
- *Presigned URLs*: the client uploads straight to R2's S3 endpoint.

Presigned URLs are the recommended choice when files are large (over the Worker body limit or
needing multipart), when clients are untrusted browsers at high volume, or when you want the
Worker off the data path. A Worker in the path is the normal choice when you need
authorisation, validation or a synchronous result at upload time.

**How our case compares:**

| Concern | Through Worker (MVP) | Presigned R2 |
|---|---|---|
| Body limit | 100 MB on Free/Pro zones; we cap uploads at 20 MB | 5 GB per PUT; multipart beyond that |
| Cost | 1 extra request per photo (about USD 0.003 per 10k). Streaming uses little CPU; wall time is not billed on Workers Standard | Same request count |
| Credentials | **None**: no S3 access key exists to leak or rotate | A bucket-scoped S3 key pair must live in Worker secrets |
| Integrity | Checked in-path, result returned synchronously | Needs storage notifications, a queue and a reconciler to find "uploaded, not processed" photos |
| Resumability | Single PUT, not resumable | Single PUT, also not resumable (multipart is a separate project) |
| CORS | Not needed (native client) | Bucket CORS needed for any future browser uploads |
| Deploys | An in-flight upload may be cut off; the booth retries | Not affected |

**Verdict.** At about 0.5 photos/second peak and 20 MB maximum, the Worker path is the simpler
*and* more secure option. It is not a shortcut we will regret.

**We would need to change it if:**
1. we add video or files near 100 MB, or need resumable or multipart uploads;
2. we add browser-based guest uploads at volume;
3. processing time per photo makes synchronous uploads hold booth slots too long;
4. we move to a zone plan where the body limit differs, or volume grows by about 100×.

**Making the switch non-breaking.** The client treats `upload` as an opaque descriptor
(`method`, `url`, `headers`, `expiresAt`), and `headers` is an open map that it sends as
given. It already handles both `201 READY` and `202 {state: "PROCESSING"}`, and recovers by
re-POSTing the intent. Moving to R2 presigned URLs then needs
only server changes:
- swap the HMAC signer for SigV4 presigning;
- add an R2 object-created notification on `events/`, feeding a Queue consumer;
- the consumer calls the **same** `processPhoto()` function (with D14: validate a stored variant
  and publish the photo when both are present).

There is no app release and no data migration. Keep `processPhoto()` free of HTTP concerns from
day 1 to preserve this.

## 10. Booth app changes

1. **Enrolment** (operator settings): enter the code from admin, and the credential is stored in
   app-private storage. Android app sandboxing protects it. The real controls are revocation and
   last-seen monitoring. Keystore wrapping through the existing Kotlin plugin is a post-MVP
   hardening item.
2. **Event selection** (operator settings): list OPEN events, then a confirmation screen showing
   the name and local date. The selected event appears in the operator status bar. Switching
   events requires confirmation, and queued items keep their original event.
3. **Outbox** (`photobooth-core::outbox`, pure Rust behind a `PortalClient` trait):
   - On reaching strip review, each shot's two variants (D14: thumb 480 px q75 and HD 2560 px
     q85, EXIF orientation applied, baseline JPEG, no metadata) are encoded from the in-memory
     original and written to `{app_data}/outbox/{clientPhotoId}.{thumb,hd}.jpg`, plus a `.json`
     record with event ID, session ID, shot, capture time, HD width and height, each variant's
     sha256 and bytes, state, attempt count and last error. The original never touches the disk;
     the SD card keeps it.
   - Encoding runs off the capture path. Measured on the tablet in session 08b: p50 0.42 s,
     p95 0.54 s per shot (spike Q10 estimated 0.6–1.6 s); the Sony JPEG is about 11.5 MB
     (spike Q8). See wiki/Booth-Upload.md.
   - Writes go to a temp file, then `fsync`, then rename, the same pattern as settings.
   - The outbox is scanned on startup and drained with 2 concurrent uploads while the app is
     running. Background-service uploading is out of scope; it is a kiosk app.
   - Files are deleted only on READY, never evicted silently. The operator is warned below 1 GB
     free.
   - No event selected or not enrolled: nothing is queued, and the booth works as it does today
     (SD archive).
   - **Test-mode (mock camera) shots are never queued.**
4. **Post-shoot screen**: a **session QR** for `galleryUrl#k=…&s={sessionId}`, rendered on the
   booth with the Rust `qrcode` crate.
   - The gallery opens filtered to this session and shows placeholders until the shots are
     READY, typically within seconds.
   - A "See all event photos" link clears the filter. The session ID only narrows the view; the
     cookie grants the whole event, the same as the event QR.
   - The existing post-shoot text is open for redesign.
5. **Operator status**: counts of queued, uploading and needs-attention items, an offline badge,
   and a needs-attention list with the reason and retry/dismiss actions. Dismiss deletes the
   local copy only after confirmation; the SD card still has it.

## 11. Guest gallery

- **Opening the link**:
  1. The SPA reads `#k` and POSTs it to `/api/session`, which sets the cookie.
  2. `history.replaceState` removes the fragment.
  3. The fragment is never sent to the server or in `Referer` headers.
- **Cookie**: `HMAC(SESSION_KEY, eventId|accessVersion|exp)`, with `Secure`, `HttpOnly`,
  `SameSite=Lax` and `Path=/e/{publicId}`. It lasts 30 days (galleries have no expiry, D15), so
  a guest returning the next day doesn't need the QR again. Each request checks `access_version`,
  so rotating the link or suspending the gallery takes effect immediately.
- **Media**:
  1. Validate the cookie.
  2. Read the event row: gallery LIVE, not deleted, version matches.
  3. Read the photo row: belongs to the event, READY, not hidden.
  4. Stream from R2. Anything unauthorised returns a generic 404.
  - Response headers: `Cache-Control: private, max-age=31536000, immutable` (a key never changes
    content, so repeat views cost no request), `X-Content-Type-Options: nosniff`.
    Downloads add `Content-Disposition: attachment; filename="<event>-<n>.jpg"`.
- **Live updates**: poll `?cursor` every 30 s (with jitter) only while the page is visible and
  the event is OPEN, plus one poll as soon as the page becomes visible again. 30 s, not 5 s,
  keeps a 200-guest event day inside the Workers Free 100,000 requests/day for the whole account
  (spike Q12: at 5 s the polls alone on a heavy day would be about 144,000). The post-shoot
  session view polls every 10 s for its first 2 minutes, so a guest sees their own shots arrive. New photos appear as a "N new"
  pill rather than shifting the grid. Thumbnails are
  lazy-loaded.
- **Privacy notice and removal contact** in the footer. These are deployment variables:
  `CONTACT_ADDRESS` = *34b Malvern Road, Morningside, Auckland* and `CONTACT_EMAIL`
  (`privacy@<domain>`, set once the domain exists). An email address is required as well as
  the postal address, because removal requests need a prompt channel. Deployment fails if either
  variable is empty.
- **Accessibility**: keyboard-operable grid and lightbox, labelled controls, WCAG 2.2 AA target.

## 12. Admin portal

- **Events**: create and edit, open and close uploads, publish and suspend the gallery, copy link,
  rotate link (with confirmation), counts by state, the date uploads close (`uploads_until`), delete with a 7-day undo.
- **Event QR**: QR code for the whole event (`galleryUrl#k=…`), with no session filter.
  - Shown on screen, and downloadable as SVG (for print and signage) and PNG (for messaging).
  - Generated in the admin SPA with one small, dependency-free QR library.
  - It is the same link the session QR uses, so rotating the link invalidates both. Printed
    signage must be reprinted after a rotation, and the rotate confirmation says so.
- **Photos**: grid by state (pending, ready, rejected), hide and unhide, delete permanently (for
  removal requests).
- **Devices**: create (shows the 10-minute code once), re-issue the code (also re-enrols an
  enrolled tablet), revoke, last seen, backlog, app version. On enrolment the device takes the name
  the booth sends, replacing the admin's placeholder (session 05).
  This is the event-day health view.
- **Audit**: event changes, publish and suspend, rotation, device create and revoke, hide and
  delete, restore.

## 13. Security controls

| Threat | Control |
|---|---|
| Admin impersonation or Access bypass | Verify the `Cf-Access-Jwt-Assertion` header against the team JWKS (Hono's JWKS verifier, `verifyWithJwks`, which the `jwk` middleware wraps; `jwk` itself only reads `Authorization: Bearer`) and check `aud`, `iss`, `exp` (required) and `nbf`, plus the `ADMIN_EMAILS` allowlist (or `ADMIN_SERVICE_CLIENTS` for a service token). Every admin request is checked, the SPA shell and `/healthz` included. Never trust the email header. Disable `workers.dev` and preview URLs. Host allowlist. |
| CSRF on admin | No CORS; mutations require a same-origin `Origin` and `application/json` |
| Cross-event access | Every guest query joins event to photo; tests try IDs from another event |
| Leaked gallery link | 128-bit-plus token, explicit rotation, suspension, operator guidance that links can be forwarded |
| Stolen or lost tablet | Admin revokes the device. Revocation also blocks any signed URLs already issued (the PUT checks the device). |
| Enrolment-code guessing | 8 base32 characters, 10-minute lifetime, single use, rate-limited per IP, identical error responses |
| Upload URL replay | 15-minute HMAC URL bound to photoId, variant, bytes and sha256; a READY photo rejects further PUTs |
| Malicious or oversized image | `Content-Length` must match the declared size (thumb ≤ 200 KB, hd ≤ 3 MB); R2 checks the sha256; the header walk (section 9.1) allows only baseline JPEG segments with no metadata, checks the declared dimensions, and requires a final EOI; only JPEG is served, with `nosniff`. **No server-side re-encode (D14)**: entropy-coded data from a stolen, unrevoked tablet could reach guests' browser decoders. Accepted for MVP because only enrolled, revocable devices can upload (spike RESULTS.md, Q10) |
| Denial of wallet | Rate-limiting binding on enrolment, session swap and intents; per-event photo limit; per-variant size caps; billing alerts. On Workers Free there is nothing to bill, but a flood can use up the account's 100,000 requests/day, so the rate limits also protect availability |
| Browser injection | React escaping; CSP `default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'`; HSTS; `Referrer-Policy: no-referrer` |
| Secret exposure | Worker secrets (`UPLOAD_KEY`, `SESSION_KEY`) live in Wrangler secrets. Logs never include query strings, cookies, tokens or bodies. Device credentials are stored hashed. |

## 14. Privacy and retention

| Data | Retention | Enforcement |
|---|---|---|
| Published variants | Until the event is deleted, then the 7-day undo (D15). Uploads stop 90 days after event end | Admin delete; daily cron prefix-deletes the purged event |
| Deleted event | 7-day undo, then purged | Daily cron |
| Booth outbox (thumb + HD variants, never the original) | Until READY | Outbox deletes on READY |
| SD-card originals | 90 days after event end | Operator process (custody register) |
| Audit | 90 days | Daily cron |
| D1 history | 30 days | D1 Time Travel (automatic) |

Removal requests are handled with "Delete permanently" in admin, which removes the variants
immediately, plus erasing the SD-card file. Guests see the privacy notice at the booth and in
the gallery. NZ privacy review and the hosting-location disclosure remain the business's
responsibility; Cloudflare location hints are not a residency guarantee.

## 15. Operations

- **Logs**: structured JSON (request ID, event ID, photo ID, device ID, version, outcome code)
  via Workers Observability. Retention is 3 days on Workers Free (7 on Paid) until 2026-12-01,
  then 7 days for both under Cloudflare Observability pricing. Successful media reads are sampled.
- **Alerts**: Cloudflare billing notifications at USD 25, 50 and 100. There is no paging in MVP.
  During events the operator watches the booth's status bar and the admin devices view (backlog,
  last seen), which v1.2's queue-age alerts would have duplicated.
- **Restore** (D1 Time Travel):
  1. Suspend galleries.
  2. Restore.
  3. Re-apply revocations and deletions from the audit export taken before the restore.
  4. Reopen.
  R2 bytes are unaffected.
- **Event-day runbook**:
  - *Before*: enrol and verify the booth, select the event, take a test shot, confirm READY,
    scan the QR on a separate phone and download, check free storage and the uplink.
  - *During*: if there's a backlog, don't clear app storage. Needs-attention items need an
    operator decision.
  - *After*: close uploads only when every booth shows a zero backlog in admin.

## 16. Cost (USD per month, in the first year; rates rechecked 2026-10-22 in spike 01)

Volume: 4 events × 500 photos = 2,000 photos a month. Photos are kept until deleted (D15), so
about 24,000 are stored after a year. Budget USD 20 all-in.
The full model, including the event-day request and D1 estimates, is in
[spike/RESULTS.md](./spike/RESULTS.md) (Q12).

| | Workers Free (D14) | Workers Paid (D14) |
|---|---|---|
| Workers (3 requests per photo, guest polling at 30 s, media cached immutably) | 0.00 | 5.00 |
| R2 storage (thumb + HD ≈ 0.44 MB per photo, ≈ 0.9 GB a month; 10 GB free) | 0.00 | 0.00 |
| R2 operations (≈ 4k Class A, ≈ 0.1–0.2 M Class B; 1 M / 10 M free) | 0.00 | 0.00 |
| D1 (≤ 1.5 M rows read on an event day; 5 M/day free) | 0.00 | 0.00 |
| Images | not used | not used |
| Domain (`.co.nz`, about NZD 30/year) | ≈ 1.50 | ≈ 1.50 |
| **Total** | **≈ 1.50** | **≈ 6.50** |

- **Free is a hard ceiling, not a bill.** Going over 100,000 requests/day, or over D1's daily
  rows, fails requests for the whole account until 00:00 UTC, uploads included. A typical event
  day is about 36,000 requests and a heavy one about 96,000, and staging shares the account.
  Keep staging idle on event days, and move the account to Workers Paid if the pilot's peak is
  over 50,000 requests a day (session 18).
- With no automatic deletion (D15), storage passes the 10 GB free tier after about 11 months
  (about 23,000 photos) and then costs USD 0.015 per GB-month: about USD 0.17 a month after two
  years. Deleting old events through admin brings it back down.
- v2.0's Images path (3 variants including a full-resolution copy) would have needed Workers
  Paid for CPU and cost ≈ USD 5.90 at this volume. It is dropped for privacy (spike Q6), not
  cost.

## 17. Testing and release gates

- **Worker**: Vitest with the Cloudflare Vitest plugin (`@cloudflare/vitest-plugin`), the
  Cloudflare-recommended option.
  - Tests run inside the Workers runtime with real local D1 and R2, isolated per test file.
  - It covers both pure modules and route integration tests.
  - With D14 there is no Images binding. The Worker's header check is pure and runs locally the
    same as on Cloudflare (spike Q9), so it is unit-tested with crafted JPEGs.
- **Web (admin, gallery SPAs)**: `bun test` with happy-dom, as in the booth.
- **Smoke**: `scripts/smoke.ts --base <url>` runs the full device → gallery flow against
  `wrangler dev` or staging.
- **Contract**: `contract/fixtures/*.json` are parsed by zod in `bun test` and by serde in
  `cargo test` (`include_str!`).
- **Booth**: variant-encoder tests (orientation 1/3/6/8 fixtures come out upright, sizes within
  caps, output passes the same header rules as the Worker, no APP1/APP2/APP13). Outbox unit tests
  (fake client, `tempfile`) covering:
  - kill during write and restart
  - retry, backoff and `Retry-After`
  - needs-attention transitions
  - event switch with items queued

  Maestro flows for enrolment, event selection and the post-shoot QR.

**Release gates:**
1. Spoofed or expired Access JWT and the alternate hostname are rejected. Revoked devices, other
   events' IDs and hidden photos fail.
2. Airplane mode for 30 minutes during a 50-shot run, plus an app kill, gives exactly 50 READY,
   no duplicates and correct event IDs.
3. Fake, truncated, oversized, progressive, metadata-bearing and trailing-data JPEGs are rejected
   by the Worker. The GPS-and-serial EXIF fixture, run through the booth's encoder, shows no
   metadata in either variant.
4. Deleting an event during uploads gives no late READY. Undo works within 7 days.
5. On staging, 5 booths upload simultaneously (about 0.5 photos/s): p95 shot-to-READY under 15 s
   on a good uplink. The first gallery grid appears in under 2.5 s on a 10 Mbps connection.
6. Keyboard and screen-reader pass on the gallery and admin. One real low-volume NZ event with
   reconciled counts.

## 18. Removed from v1.2, and why

| v1.2 element | Replaced by or why removed |
|---|---|
| Presigned R2 URLs, S3 keys, attempt IDs, URL renewal, completion hint | Worker-signed URL with in-path upload (section 9) |
| R2 notifications, Queue, DLQ, leases, fencing tokens, publication versions | Synchronous processing, fixed keys, conditional UPDATE |
| Maintenance reconciler (stuck PENDING, orphan sweep, JobCursor) | Booth outbox retries; prefix delete on purge |
| 3 buckets, 7-day recovery copy | 1 bucket; SD card archive; 7-day event soft delete |
| 4 Workers, 3 hostnames, separate monitoring Worker | 1 Worker, 2 hostnames |
| Pairing sessions, approval phrase, polling | One-time admin-issued enrolment code |
| 30-day device credential expiry | Revocable, with last-seen monitoring. A mid-event expiry would be a self-inflicted outage. |
| Byte-quota reservation and reconciliation | Atomic per-event photo count limit plus per-variant caps |
| Server-side re-encode (v2.0: Images binding, 3 variants) | Booth-made thumb + HD (D14): the binding keeps GPS/serial EXIF and needs Workers Paid for CPU (spike Q6, Q11) |
| Guest passcode, KDF tuning | Removed (not needed for MVP) |
| GuestSession table, 12-hour sessions | Stateless signed cookie until expiry, checked against `access_version` |
| Share secret hashed and shown once | Stored retrievably (booth QR, reprint); rotation invalidates |
| Admin preview handoff token | Admin media proxy on the admin host |
| Private Cache API layer | Direct R2 after the access check |
| Daily D1 exports, DeletionManifest | D1 Time Travel; prefix delete |
| OpenAPI | zod plus serde with shared fixtures |
| "Shared Tauri/React codebase" for the portal | Separate `apps/portal`; Tauri adds nothing to a browser SPA |
| SD-card reupload tooling | Post-MVP (the SD card's JPEG may not match the transferred bytes, so dedupe is uncertain) |

## 19. Delivery plan

| Phase | Deliverable | Days |
|---|---|---|
| 0 Spike | Done (session 01, [spike/RESULTS.md](./spike/RESULTS.md)): R2 `sha256` verified; Images binding rejected (keeps EXIF, needs Paid CPU); booth-made variants chosen (D14). Not done: Sony size over PTP and on-tablet encode time (moved to the booth track) | 1–2 |
| 1 Foundation | Worker skeleton, host routing, Access JWT, D1 migrations, bucket, staging and production envs, CI (typecheck, test, deploy staging; production manual), admin events CRUD | 3–4 |
| 2 Live upload | Device enrolment and revoke, events API, intent and per-variant PUT with header check, booth variant encoder, outbox, client, event selection, operator status | 6–9 |
| 3 Gallery | Guest session, gallery SPA with polling, media and download, post-shoot QR and session filter | 3–4 |
| 4 Hardening and pilot | Moderation, retention cron and soft delete, audit, security tests, release gates, pilot event | 4–5 |
| **Total** | | **17–24** |

## 20. Open questions

1. Final domain name (expected `.co.nz`). It is needed before staging Access is set up
   (phase 1), but not for the spike or local development.

Resolved:
- D3: cancelled sessions do not upload.
- D9: the share token is stored retrievably.
- TLD: probably `.co.nz`. The design does not depend on it (section 4.1).
- Post-shoot QR opens the guest's session; admins can also generate an event-wide QR.
- Contact address: 34b Malvern Road, Morningside, Auckland, plus `privacy@<domain>`.
- Environments: one dedicated business account with separate staging and production
  resources (section 4.1).
