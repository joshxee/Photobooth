# Photobooth Portal: MVP Solution Design (v2.2)

Status: **accepted**, no implementation yet. **D14 was confirmed by the user on 2026-10-22**,
with the spike's GO.
- v2.1 applied the spike results ([spike/RESULTS.md](./spike/RESULTS.md)) to §1–§9.3: the booth
  makes the variants (D14), the Worker stores and checks them, and the target volume is 2,000
  photos a month.
- The spike's review follow-up (PR #17) aligned the restored §9.3–§19 with D14: baseline-only
  header walk with a final EOI check, 30 s polling, immutable media caching, the cost rewrite and
  17–24 days.
- v2.2 (session 01b, after the user's confirmation) completes the job and keeps #17's decisions:
  §9.4 rewritten (no in-request processing; `acceptVariant()` replaces `processPhoto()`), §10
  (the variant encoder as its own item, owned by session 08b, with an encode-time gate), §11
  (variants, the 10 s session-view burst), §12, §13 (metadata row, the daily-limit flood row),
  §14, §15 (Workers Free limits), §16 (the full event-day request model and the triggers for
  Workers Paid), §17 (testing seams; the metadata gate on the booth encoder and the Worker),
  §18 (what D14 changed from v2.0), §19 and §20.
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
| Base cost | USD 0/month of Cloudflare usage on Workers Free (2,000 photos/month, 90-day retention, about 2.6 GB stored), about USD 1.50/month all-in with the domain; USD 5 more if the account moves to Workers Paid for request headroom (section 16). Budget: USD 20/month all-in |
| Effort | 17–24 engineering days, including the spike and 1–2 days for the booth's variant encoder (D14) |

## 2. Scope

**In scope:**
- single-image galleries (each shot is its own photo)
- live updates by polling
- HD download (2560 px long edge) of the sanitised copy. The full-resolution original stays on the
  camera's SD card
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
| D14 | **The booth makes the variants** (thumb 480 px q75, HD 2560 px q85, orientation applied, no metadata) in Rust; the Worker never decodes (spike Q10, option B). **Confirmed by the user on 2026-10-22.** | The Images binding keeps GPS and serial numbers whatever `metadata` is set to (Q6). It also needs Workers Paid for CPU (355–470 ms per photo against the Free 10 ms, Q11) and caps inputs at 20,000,000 bytes (Q3). Uploading 0.25–0.62 MB instead of 11–17 MB per shot is 28–44× less traffic on venue networks. Trade-off: guests' browsers decode the booth's JPEG rather than a Cloudflare re-encode. Uploads come only from enrolled, revocable devices, and the header walk limits what is stored (RESULTS.md, Q10) | Uploads from devices we don't own, or on-tablet encoding is too slow (unverified, estimated 0.6–1.6 s per shot) |

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
                                               │D1        │R2 bucket
```

The Worker routes on the `Host` header, and an unknown host returns 404. `workers.dev` and preview
URLs are **disabled** in production, so Access cannot be bypassed through an alternate hostname.

### 4.1 Account, domain and environments

**Account.** Use one Cloudflare account **dedicated to the business**, not a personal or shared
one. Separate accounts for staging and production are standard for larger organisations, but
for a startup they double the setup (billing, Access team, API tokens) for little isolation
benefit. Staging's synthetic traffic barely touches the free allowances, but it shares the
account's Workers Free limit of 100,000 requests a day with production (section 15).
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
- The personal account was used only for the throwaway spike (session 01). Its Worker and
  bucket were deleted on 2026-10-22 (RESULTS.md, Clean-up).
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
  without a zone, so nothing before session 07 needs staging. (The spike instead deployed a
  throwaway Worker to the personal account's `workers.dev`, then deleted it.)
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
  chosen and measured on the tablet by session 08b.

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
Errors look like `{code, message, correlationId}`.

**Device** (`photos.<domain>`, `Authorization: Bearer <device credential>`, except enrolment):

| Route | Purpose |
|---|---|
| `POST /v1/device/enrol` `{code, name, appVersion}` | Swap the one-time code for a credential (returned once). Rate-limited per IP. |
| `GET /v1/device/events` | OPEN events: id, name, venue, local date, timezone |
| `GET /v1/device/events/{id}` | Event detail plus `galleryUrl` (with token) when the gallery is LIVE, for the post-shoot QR |
| `POST /v1/device/photos` | Upload intent (section 9). Idempotent on `clientPhotoId`. |
| `PUT /v1/device/uploads/{photoId}/{variant}?exp&sig` | Upload and check one variant (section 9). Authorised by the signed URL. |

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

## 9. Upload and validation

### 9.1 Flow

```
Booth                         Worker                                   D1 / R2
0 after the session completes: decode, apply EXIF orientation, encode thumb + hd without
  metadata (D14); the outbox stores the two variants, not the original
1 POST /v1/device/photos {eventId, clientPhotoId, sessionId, shot, capturedAt, width, height,
                          variants: {thumb: {bytes, sha256}, hd: {bytes, sha256}}}
                              device active? event OPEN, not deleted? thumb ≤ 200 KB,
                                     hd ≤ 3 MB and ≤ 2560 px?
                              INSERT-if-under-limit … ON CONFLICT(device_id, client_photo_id)
   ◄── READY  → done (nothing to upload)
   ◄── PENDING + uploads {thumb, hd: {method:PUT, url (HMAC, exp 15 min), headers, expiresAt}}
       (only the variants not yet stored)
   ◄── REJECTED (an earlier PUT failed the header check) → needs attention
   ◄── 409 mismatch (same clientPhotoId, different hashes or event) / event_closed / limit
2 PUT uploads.<variant>.url   (body = JPEG, exact Content-Length, Content-Type image/jpeg)
                              verify sig/exp; photo PENDING (READY → 201, REJECTED → 422);
                                     device not revoked; event not deleted
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
| 401/403 (revoked), 409 event_closed or limit, 422 invalid image, REJECTED intent | **Needs attention**: the variants are kept and shown to the operator; no automatic retry. A 422 invalid image from the booth's own encoder is a booth bug |

### 9.4 Upload through the Worker: is it best practice, and will we have to change it?

With D14 the Worker does no image processing. Each upload request is a streamed `sha256` put, a
64 KB range read and a header walk, at about 1 ms CPU (spike Q11). Nothing slow is left to move
to an asynchronous path, so this section now asks only whether the bytes should pass through the
Worker at all.

**What Cloudflare documents.** Both patterns are documented and supported:

- *Worker binding upload*: the Worker receives the body and calls `env.MEDIA.put`.
- *Presigned URLs*: the client uploads straight to R2's S3 endpoint.

Presigned URLs are the recommended choice when files are large (over the Worker body limit or
needing multipart), when clients are untrusted browsers at high volume, or when you want the
Worker off the data path. A Worker in the path is the normal choice when you need
authorisation, validation or a synchronous result at upload time.

**How our case compares:**

| Concern | Through Worker (MVP) | Presigned R2 |
|---|---|---|
| Body limit | 100 MB on Free/Pro zones; our variants are capped at 200 KB (thumb) and 3 MB (hd) | 5 GB per PUT; multipart beyond that |
| Cost | 2 Worker requests per photo (one per variant) plus the intent: about 1,500 on a 500-photo event day, inside the Workers Free 100,000 a day (spike Q12). About 1 ms CPU each | The PUTs skip the Worker, but the intent and a completion step remain |
| Credentials | **None**: no S3 access key exists to leak or rotate | A bucket-scoped S3 key pair must live in Worker secrets |
| Integrity | Checked in-path (R2 `sha256`, spike Q1), result returned synchronously | Needs storage notifications, a queue and a consumer to find "uploaded, not checked" variants |
| Resumability | Single PUT, not resumable (variants are under 1 MB, so this does not matter) | Single PUT, also not resumable (multipart is a separate project) |
| CORS | Not needed (native client) | Bucket CORS needed for any future browser uploads |
| Deploys | An in-flight upload may be cut off; the booth retries | Not affected |

**Verdict.** At about 0.5 photos/second peak and under 1 MB per photo, the Worker path is the
simpler *and* more secure option. It is not a shortcut we will regret.

**We would need to change it if:**
1. we add video or files near 100 MB, or need resumable or multipart uploads;
2. we add browser-based guest uploads at volume;
3. upload requests take a large share of the daily request limit, or volume grows by about 100×;
4. we move to a zone plan where the body limit differs.

**Making the switch non-breaking.** The client treats each `uploads.<variant>` entry as an opaque
descriptor (`method`, `url`, `headers`, `expiresAt`). It already handles `201 READY`,
`200 STORED` and `202 PENDING`, and recovers by re-POSTing the intent. Moving to R2 presigned
URLs then needs only server changes:
- swap the HMAC signer for SigV4 presigning, with the declared `sha256` signed in as
  `x-amz-checksum-sha256`;
- add an R2 object-created notification on `events/`, feeding a Queue consumer (Queues are on
  Workers Free, 10,000 operations a day);
- the consumer calls the **same** `acceptVariant()` function: header walk, `<variant>_stored`,
  READY.

There is no app release and no data migration. Keep `acceptVariant()` free of HTTP types from
day 1 to preserve this.

## 10. Booth app changes

1. **Enrolment** (operator settings): enter the code from admin, and the credential is stored in
   app-private storage. Android app sandboxing protects it. The real controls are revocation and
   last-seen monitoring. Keystore wrapping through the existing Kotlin plugin is a post-MVP
   hardening item.
2. **Event selection** (operator settings): list OPEN events, then a confirmation screen showing
   the name and local date. The selected event appears in the operator status bar. Switching
   events requires confirmation, and queued items keep their original event.
3. **Variant encoder** (`photobooth-core::variants`, pure Rust, D14):
   - Input: the camera JPEG held in `PhotoStore`. Output: `thumb` (fit 480×480, quality 75) and
     `hd` (fit 2560×2560, quality 85), baseline (SOF0, single scan) sRGB JPEGs with the EXIF
     orientation applied.
   - The output carries no metadata: only an APP0 JFIF segment, with no EXIF, XMP, IPTC, ICC or
     comment. The Worker rejects metadata segments (section 9.1), so an encoder regression shows
     up as `invalid_image`, not as a leak.
   - Decode with DCT scaling where the decoder offers it (for example 1/2 scale for a
     6000×4000 source), then resize with a Lanczos-class filter. One shot at a time, holding at
     most one decoded frame (about 18 MB with scaled decode, 72 MB without).
   - It runs after the session completes, off the UI thread, so it never delays capture or the
     review screen. At `StripReview` the session-complete hook receives its own copies of the
     session's JPEG bytes (cheap `Bytes` clones), because `PhotoStore` is cleared when the booth
     returns to attract or starts another run, which can happen mid-encode.
   - Budget: shot-to-READY must stay under 15 s for a 3-shot session (release gate 5), so with
     about 2 s for uploads the encoder gets **at most 3 s per shot at p95** on the Xiaomi Pad 6.
     The spike estimated 0.6–1.6 s (**unverified**). Session 08b measures it; if p95 is over
     3 s per shot, stop and revisit D14 with the user.
   - The original is never written to the booth's disk; the camera's SD card keeps it (D1).
4. **Outbox** (`photobooth-core::outbox`, pure Rust behind a `PortalClient` trait):
   - After the session completes, each shot's variants are written to
     `{app_data}/outbox/{clientPhotoId}.thumb.jpg` and `{clientPhotoId}.hd.jpg`, plus a `.json`
     record with event ID, session ID, shot, capture time, HD width and height, each variant's
     sha256 and byte size, state, attempt count and last error.
   - Writes go to a temp file, then `fsync`, then rename, the same pattern as settings. The
     record is written last, so a record always has both variants.
   - The outbox is scanned on startup and drained with 2 photos in flight while the app is
     running. Each intent returns upload URLs only for the variants the server has not stored.
     Background-service uploading is out of scope; it is a kiosk app.
   - Files are deleted only on READY, never evicted silently. A shot takes about 0.44 MB, so
     1 GB holds about 2,000 shots. The operator is warned below 1 GB free.
   - No event selected or not enrolled: nothing is encoded or queued, and the booth works as it
     does today (SD archive).
   - **Test-mode (mock camera) shots are never queued.**
   - Shots are encoded from memory after the session completes. A crash in the seconds between
     completion and enqueue loses those shots from the upload; the SD card still has them. That
     window existed before D14 and is now longer by the encode time (accepted).
5. **Post-shoot screen**: a **session QR** for `galleryUrl#k=…&s={sessionId}`, rendered on the
   booth with the Rust `qrcode` crate.
   - The gallery opens filtered to this session and shows placeholders until the shots are
     READY, typically within seconds of the session completing (encode plus upload).
   - A "See all event photos" link clears the filter. The session ID only narrows the view; the
     cookie grants the whole event, the same as the event QR.
   - The existing post-shoot text is open for redesign.
6. **Operator status**: counts of queued, uploading and needs-attention items, an offline badge,
   and a needs-attention list with the reason and retry/dismiss actions. Dismiss deletes the
   local copy only after confirmation; the SD card still has it.

## 11. Guest gallery

- **Opening the link**:
  1. The SPA reads `#k` and POSTs it to `/api/session`, which sets the cookie.
  2. `history.replaceState` removes the fragment.
  3. The fragment is never sent to the server or in `Referer` headers.
- **Cookie**: `HMAC(SESSION_KEY, eventId|accessVersion|exp)`, with `Secure`, `HttpOnly`,
  `SameSite=Lax` and `Path=/e/{publicId}`. It lasts until gallery expiry (capped at 30 days), so
  a guest returning the next day doesn't need the QR again. Each request checks `access_version`,
  so rotating the link or suspending the gallery takes effect immediately.
- **Media** (variant `thumb` or `hd`; anything else returns 404):
  1. Validate the cookie.
  2. Read the event row: gallery LIVE, not deleted, not expired, version matches.
  3. Read the photo row: belongs to the event, READY, not hidden.
  4. Stream from R2. Anything unauthorised returns a generic 404.
  - Response headers: `Cache-Control: private, max-age=31536000, immutable` (section 7: a key
    never changes content, and refetches would cost Workers Free requests),
    `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`. Downloads add
    `Content-Disposition: attachment; filename="<event>-<n>.jpg"`.
  - A photo that is later hidden or deleted stays in the private browser cache of guests who
    already opened it; the server stops serving it at once. This is accepted: those guests have
    already seen it.
- **Variants**: the grid uses `thumb`; the lightbox and the download use `hd` (2560 px). There is
  no full-resolution download; the SD card keeps the original (section 2).
- **Live updates**: poll `?cursor` every 30 s (with jitter) only while the page is visible and
  the event is OPEN, plus one poll as soon as the page becomes visible again. The
  session-filtered view (post-shoot QR) polls every 10 s for its first 2 minutes, while the
  guest's own shots arrive, then drops to 30 s. New photos appear as an "N new" pill rather than
  shifting the grid. Thumbnails are lazy-loaded.
  - Why 30 s: on Workers Free every poll counts toward the account's 100,000 requests a day
    (spike Q12). At v2.0's 5 s the polls alone on a heavy day would be about 144,000. Section 16
    has the event-day budget.
- **Privacy notice and removal contact** in the footer. These are deployment variables:
  `CONTACT_ADDRESS` = *34b Malvern Road, Morningside, Auckland* and `CONTACT_EMAIL`
  (`privacy@<domain>`, set once the domain exists). An email address is required as well as
  the postal address, because removal requests need a prompt channel. Deployment fails if either
  variable is empty.
- **Accessibility**: keyboard-operable grid and lightbox, labelled controls, WCAG 2.2 AA target.

## 12. Admin portal

- **Events**: create and edit, open and close uploads, publish and suspend the gallery, copy link,
  rotate link (with confirmation), counts by state, expiry date shown, delete with a 7-day undo.
- **Event QR**: QR code for the whole event (`galleryUrl#k=…`), with no session filter.
  - Shown on screen, and downloadable as SVG (for print and signage) and PNG (for messaging).
  - Generated in the admin SPA with one small, dependency-free QR library.
  - It is the same link the session QR uses, so rotating the link invalidates both. Printed
    signage must be reprinted after a rotation, and the rotate confirmation says so.
- **Photos**: grid by state (pending, ready, rejected with the reason), hide and unhide, delete
  permanently (for removal requests). The admin media proxy serves `thumb` and `hd` in any state
  with `Cache-Control: private, no-store`.
- **Devices**: create (shows the 10-minute code once), revoke, last seen, backlog, app version.
  This is the event-day health view.
- **Audit**: event changes, publish and suspend, rotation, device create and revoke, hide and
  delete, restore.

## 13. Security controls

| Threat | Control |
|---|---|
| Admin impersonation or Access bypass | Verify the `Cf-Access-Jwt-Assertion` header against the team JWKS (Hono `jwk` middleware) and check `aud`, `iss` and `exp`, plus the `ADMIN_EMAILS` allowlist. Never trust the email header. Disable `workers.dev` and preview URLs. Host allowlist. |
| CSRF on admin | No CORS; mutations require a same-origin `Origin` and `application/json` |
| Cross-event access | Every guest query joins event to photo; tests try IDs from another event |
| Leaked gallery link | 128-bit-plus token, explicit rotation, suspension, operator guidance that links can be forwarded |
| Stolen or lost tablet | Admin revokes the device. Revocation also blocks any signed URLs already issued (the PUT checks the device). |
| Enrolment-code guessing | 8 base32 characters, 10-minute lifetime, single use, rate-limited per IP, identical error responses |
| Upload URL replay | 15-minute HMAC URL bound to photoId, variant, bytes and sha256. The hash fixes the bytes, so a replay can only rewrite the same content; a READY photo accepts no further writes |
| Malicious or oversized image | Only enrolled, unrevoked devices can get upload URLs (bearer credential, then a signed URL per variant). `Content-Length` must equal the declared size, capped at 200 KB (thumb) and 3 MB (hd); R2 checks the sha256. The Worker walks the headers without decoding: SOI, a segment allowlist (APP0 JFIF, APP14 Adobe, DQT, DHT, DRI, SOF0 baseline only, so there is a single scan), SOF dimensions (hd equal to the declared size, thumb within 480 px), SOS within the first 64 KB, and a final EOI. Anything else deletes the object and REJECTS the photo. Media is served only as `image/jpeg` with `nosniff` and the CSP. **Accepted residual risk (D14, spike Q10):** the Worker never re-encodes, so a JPEG with valid headers and a crafted entropy-coded segment, uploaded from a stolen and unrevoked tablet, would reach guests' browser decoders. Accepted for MVP because only owned devices upload and browser JPEG decoders are heavily fuzzed. Revisit if uploads ever come from devices we don't own. |
| Metadata leak (GPS, serial numbers) | The booth encoder writes no metadata (D14). The Worker rejects APP1, APP2, APP13, COM, every other segment off the allowlist, and progressive frames (whose later scans could hide segments past the 64 KB walk). Release gate 3 checks both sides with a GPS and serial-number fixture. |
| Denial of wallet | Rate-limiting binding on enrolment, session swap and intents; per-event photo limit; fixed variant size caps; billing alerts. On Workers Free there is no per-request bill: overuse hits the daily limit instead (next row). |
| Request flood against the Workers Free daily limit | 100,000 requests a day per account; over it, every request fails until 00:00 UTC, uploads included. A zone WAF rate-limiting rule on `photos.<domain>` (the Free zone plan includes one) stops floods before they reach the Worker. The booth outbox keeps every shot, so a flood delays delivery but loses nothing. Workers Paid removes the daily limit if this becomes a real risk (section 16). |
| Browser injection | React escaping; CSP `default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'`; HSTS; `Referrer-Policy: no-referrer` |
| Secret exposure | Worker secrets (`UPLOAD_KEY`, `SESSION_KEY`) live in Wrangler secrets. Logs never include query strings, cookies, tokens or bodies. Device credentials are stored hashed. |

## 14. Privacy and retention

| Data | Retention | Enforcement |
|---|---|---|
| Published variants (thumb, hd) | 90 days after event end | Access check at expiry; daily cron prefix-deletes |
| Variants of a photo that never became READY | Until the event is purged | The purge prefix-deletes `events/{eventId}/` |
| Deleted event | 7-day undo, then purged | Daily cron |
| Booth outbox (variants only) | Until READY | Outbox deletes on READY |
| Camera originals on the booth | The current session only | `PhotoStore` (memory only); never written to the booth's disk |
| SD-card originals | 90 days after event end | Operator process (custody register) |
| Audit | 90 days | Daily cron |
| D1 history | 30 days | D1 Time Travel (automatic) |

Removal requests are handled with "Delete permanently" in admin, which removes both variants
immediately, plus erasing the SD-card file. Guests see the privacy notice at the booth and in
the gallery. Served media carries no metadata (no GPS, camera serial numbers or capture
settings; D14). NZ privacy review and the hosting-location disclosure remain the business's
responsibility; Cloudflare location hints are not a residency guarantee.

## 15. Operations

- **Logs**: structured JSON (request ID, event ID, photo ID, device ID, version, outcome code)
  via Workers Logs. On Workers Free that means 200,000 log events a day and 3-day retention
  until 2026-12-01, then Cloudflare Observability pricing (Free: 0.5 GB a day, 7-day retention).
  Successful media reads are sampled to stay inside the allowance.
- **Alerts**: Cloudflare billing notifications at USD 25, 50 and 100 (a safety net for R2 or a
  later move to Workers Paid). Cloudflare also emails when D1's free daily limits are reached.
  There is no paging in MVP. During events the operator watches the booth's status bar and the
  admin devices view (backlog, last seen), which v1.2's queue-age alerts would have duplicated.
- **Workers Free limits** (the plan for staging, the pilot and production until a section 16
  trigger fires):
  - 100,000 requests a day **per account**, reset at 00:00 UTC. Staging and production share
    it, so no load tests (release gate 5) on an event day.
  - Over the limit, every request fails with error 1027 until the reset, uploads included.
    Routes have a fail-open/fail-closed toggle in the dashboard (not in `wrangler.jsonc`); set it
    to fail closed where it applies (session 07 checks how Custom Domains behave). The booth outbox keeps
    the shots, so the gallery stops being live but nothing is lost.
  - 10 ms CPU per invocation, including the scheduled job. Upload requests use about 1 ms
    (spike Q11). Watch p95 per route with `wrangler tail --format json` (`cpuTime`).
  - 50 external subrequests and 1,000 to Cloudflare services (R2, D1) per invocation.
  - D1 Free: 5 M rows read and 100 k rows written a day, enforced since 2026-09-01.
- **Restore** (D1 Time Travel):
  1. Suspend galleries.
  2. Restore.
  3. Re-apply revocations and deletions from the audit export taken before the restore.
  4. Reopen.
  R2 bytes are unaffected.
- **Event-day runbook**:
  - *Before*: enrol and verify the booth, select the event, take a test shot, confirm READY,
    scan the QR on a separate phone and download, check free storage and the uplink. Make sure
    no staging load test or second event is planned for the same UTC day.
  - *During*: if there's a backlog, don't clear app storage. Needs-attention items need an
    operator decision.
  - *After*: close uploads only when every booth shows a zero backlog in admin.

## 16. Cost (USD per month; spike Q12, prices as of 2026-10-22)

Assumptions: 4 events a month × 500 photos = 2,000 photos a month, 90-day retention, so about
6,000 photos stored. Event day: one booth, about 200 guests. Each photo stores thumb + hd, about
0.44 MB (spike Q7). Originals stay on the SD card. The full model is in
[spike/RESULTS.md](./spike/RESULTS.md) (Q12).

| Item | Workers Free (MVP plan) | Workers Paid (only if needed) |
|---|---|---|
| Workers | 0 (100,000 requests a day, 10 ms CPU) | 5.00 (10 M requests, 30 M CPU-ms a month included) |
| R2 storage: 6,000 × 0.44 MB ≈ 2.6 GB (worst fixture 3.7 GB); 10 GB-month free | 0 | 0 |
| R2 Class A: 2 puts per photo = 4,000; 1 M free | 0 | 0 |
| R2 Class B: 90–170 k media reads + 4 k range reads; 10 M free | 0 | 0 |
| D1: inside the free daily limits (below) | 0 | 0 |
| Images | not used (D14) | not used |
| **Total (Cloudflare)** | **0** | **5.00** |
| Domain (`.co.nz`, about NZD 30 a year, billed outside Cloudflare) | ≈ 1.50 | ≈ 1.50 |
| **All-in** | **≈ 1.50** | **≈ 6.50** |

Storage passes the 10 GB free tier only at about 23,000 stored photos (about 7,700 a month at
90-day retention), and then costs USD 0.015 per GB-month. Every case stays well inside the
USD 20 budget. v2.0's Images path would have needed Workers Paid for CPU and cost about
USD 5.90 at this volume; it was dropped for privacy (spike Q6), not cost.

**Requests on an event day** (the Workers Free limit is per day, so this is what matters):

| Source | Typical | Heavy | Notes |
|---|---|---|---|
| Booth uploads | 1,500 | 1,500 | intent + 2 PUTs per photo × 500 |
| Booth device calls | 720 | 720 | event refresh and heartbeats, about one every 30 s for 6 h |
| Gallery opens + token swap | 800 | 800 | 200 guests × 3 opens + 200 swaps (SPA assets are static and free) |
| Gallery polls | 8,000 | 48,000 | 200 guests × visible time ÷ interval: 20 min at 30 s, vs 60 min at 15 s |
| Post-shoot session view | 3,000 | 3,000 | 125 sessions × 2 phones × one poll every 10 s for 2 min |
| Media | 22,000 | 42,000 | 100 vs 200 thumbs plus 10 HD views per guest; immutable private caching stops refetches |
| **Total** | **≈ 36,000** | **≈ 96,000** | Limit 100,000 a day (resets 00:00 UTC; an NZ evening event falls in one UTC day) |

The heavy column keeps the spike's deliberately pessimistic 15 s polling (for example a faster
client, or many reloads). At the designed 30 s, heavy polls would be about 24,000 and the heavy
total about 72,000. Either way the margin is thin, which is why the triggers below exist.

D1 on that day: a poll reads at most 1 event row and 24 photo rows through the
`(event_id, state, hidden, published_at, id)` index, and a media read 2 rows, so about 0.3 M
(typical) to 1.4 M (heavy) of the 5 M rows read a day, plus about 125,000 for the photo-limit
`COUNT(*)` in 500 intents. Writes: about 500 × 4 plus throttled `last_seen` updates, about
5,000 of 100,000 a day.

**When Workers Paid would be needed.** The plan is per account, so staging and production
change together. Stay on Workers Free while all of these hold, and move the account to Workers
Paid (USD 5 a month, a plan change with no code change) as soon as one fails:
- the busiest day's requests (Workers analytics) stay under 50,000, half the limit. Session 18
  reads this from the pilot;
- one booth and about 200 guests per event, and at most one event per UTC day;
- staging can be kept idle (no deploys, smoke runs or load tests) on event days;
- every route's p95 CPU stays well under 10 ms, which rules out any server-side image work;
- 3-day log retention is enough until 2026-12-01;
- no flood has hit the daily limit (section 13).

## 17. Testing and release gates

- **Worker**: Vitest with the Cloudflare Vitest plugin (`@cloudflare/vitest-plugin`), the
  Cloudflare-recommended option.
  - Tests run inside the Workers runtime with real local D1 and R2, isolated per test file. Local
    R2 enforces `sha256` with the production error (spike Q9), so the whole upload path,
    including the hash mismatch and the header walk, is tested locally. No binding behaves
    differently on staging, so nothing is left that only staging can check.
  - It covers both pure modules and route integration tests.
  - **Seams**: `domain/jpegHeaders.ts` (the header walk) is a pure function over bytes, tested
    with tables of synthetic JPEGs built by splicing segments into a minimal JPEG (no image
    library). `domain/acceptVariant.ts` takes the bucket, the database and a clock through small
    interfaces and no HTTP types (section 9.4). The upload URL signer sits behind an interface,
    so a SigV4 signer can replace the HMAC one.
- **Web (admin, gallery SPAs)**: `bun test` with happy-dom, as in the booth.
- **Smoke**: `scripts/smoke.ts --base <url>` runs the full device → gallery flow against
  `wrangler dev` or staging, uploading a committed pair of synthetic variant fixtures.
- **Contract**: `contract/fixtures/*.json` are parsed by zod in `bun test` and by serde in
  `cargo test` (`include_str!`).
- **Booth**:
  - Variant encoder unit tests (`cargo test -p photobooth-core`), on synthetic inputs generated
    in the test (never guest photos): EXIF orientations 1–8 give the right output size and pixel
    orientation; outputs fit 480 and 2560 px; every output is baseline and passes the same
    header rules as the Worker; an input carrying GPS, body and lens serial numbers and XMP
    gives outputs with none of them.
  - On the tablet (session 08b): encode time per shot, p50 and p95, on real Sony captures, and
    the real Sony JPEG size (spike Q8).
  - Outbox unit tests (fake client, `tempfile`) covering:
    - kill during write and restart
    - retry, backoff and `Retry-After`
    - needs-attention transitions
    - event switch with items queued
    - a photo with one variant already stored uploads only the other

  Maestro flows for enrolment, event selection and the post-shoot QR.

**Release gates:**
1. Spoofed or expired Access JWT and the alternate hostname are rejected. Revoked devices, other
   events' IDs and hidden photos fail.
2. Airplane mode for 30 minutes during a 50-shot run, plus an app kill, gives exactly 50 READY,
   no duplicates and correct event IDs.
3. **No metadata and no malformed media, checked on both sides.** The booth is the only place
   metadata is removed, and the Worker's check is the backstop if a booth build regresses, so
   both are gates:
   - *Booth encoder*: the GPS and serial-number fixture, and a real Sony capture on the tablet,
     give variants with only allowlisted segments and the correct orientation.
   - *Worker, on staging*: a variant with APP1 (GPS EXIF), APP2, APP13 or COM, a progressive
     JPEG, a JPEG with trailing data after EOI, a PNG renamed `.jpg`, a truncated JPEG, an
     oversized variant and an hd whose SOF size differs from the declared size are each rejected,
     and nothing is left in R2.
4. Deleting an event during uploads gives no late READY. Undo works within 7 days.
5. On staging, 5 booths upload simultaneously (about 0.5 photos/s): p95 shot-to-READY under 15 s
   on a good uplink, counted from the end of the session so it includes encoding, and every
   route's p95 CPU well under 10 ms. The first gallery grid appears in under 2.5 s on a 10 Mbps
   connection. Not on an event day (the request limit is shared, section 15).
6. Keyboard and screen-reader pass on the gallery and admin. One real low-volume NZ event with
   reconciled counts.

## 18. Removed from v1.2, and why

| v1.2 element | Replaced by or why removed |
|---|---|
| Presigned R2 URLs, S3 keys, attempt IDs, URL renewal, completion hint | Worker-signed URL per variant with in-path upload (section 9) |
| R2 notifications, Queue, DLQ, leases, fencing tokens, publication versions | Synchronous validation, fixed keys, conditional UPDATE |
| Maintenance reconciler (stuck PENDING, orphan sweep, JobCursor) | Booth outbox retries; prefix delete on purge |
| 3 buckets, 7-day recovery copy | 1 bucket; SD card archive; 7-day event soft delete |
| 4 Workers, 3 hostnames, separate monitoring Worker | 1 Worker, 2 hostnames |
| Pairing sessions, approval phrase, polling | One-time admin-issued enrolment code |
| 30-day device credential expiry | Revocable, with last-seen monitoring. A mid-event expiry would be a self-inflicted outage. |
| Byte-quota reservation and reconciliation | Atomic per-event photo count limit plus per-variant size caps |
| Guest passcode, KDF tuning | Removed (not needed for MVP) |
| GuestSession table, 12-hour sessions | Stateless signed cookie until expiry, checked against `access_version` |
| Share secret hashed and shown once | Stored retrievably (booth QR, reprint); rotation invalidates |
| Admin preview handoff token | Admin media proxy on the admin host |
| Private Cache API layer | Direct R2 after the access check |
| Daily D1 exports, DeletionManifest | D1 Time Travel; prefix delete |
| OpenAPI | zod plus serde with shared fixtures |
| "Shared Tauri/React codebase" for the portal | Separate `apps/portal`; Tauri adds nothing to a browser SPA |
| SD-card reupload tooling | Post-MVP (the SD card's JPEG may not match the transferred bytes, so dedupe is uncertain) |

**Changed from v2.0 by D14** (spike 01, confirmed by the user on 2026-10-22):

| v2.0 element | Replaced by |
|---|---|
| Images binding (`info`, 3 transforms per photo) | The booth makes thumb + hd in Rust (section 10); the Worker walks headers without decoding |
| Variants thumb / preview (2048 px) / full (original size) | thumb (480 px) and hd (2560 px). No full-resolution download; the SD card keeps the original |
| Upload of the 11–17 MB original, 20 MB intent cap | Upload of two variants (0.25–0.62 MB), capped at 200 KB and 3 MB |
| `incoming/` prefix, 1-day lifecycle rule, inline delete | Variants go straight to their final keys |
| `processPhoto()` and the `ImageProcessor` interface | `acceptVariant()` and the pure header walk |
| `metadata: none` on the transforms | The booth encodes without metadata; the Worker rejects metadata segments (the binding ignored `metadata`, spike Q6) |
| Workers Paid (USD 5) plus Images transformations (USD 0.50–12.50 a month) | Workers Free, USD 0 of Cloudflare usage a month (section 16) |

## 19. Delivery plan

| Phase | Deliverable | Days |
|---|---|---|
| 0 Spike | **Done 2026-10-22: GO with D14** ([spike/RESULTS.md](./spike/RESULTS.md)). Verified R2 `sha256` enforcement, streaming puts, Images limits and metadata behaviour, CPU per request and the cost model. Carried forward to session 08b: the real Sony JPEG size (Q8) and the on-tablet encode time | 1–2 |
| 1 Foundation | Worker skeleton, host routing, Access JWT, D1 migrations, bucket, staging and production envs, CI (typecheck, test, deploy staging; production manual), admin events CRUD | 3–4 |
| 2 Live upload | Device enrolment and revoke, events API, intent and per-variant PUT with header validation, booth variant encoder, outbox, client, event selection, operator status | 6–9 |
| 3 Gallery | Guest session, gallery SPA with polling, media and download, post-shoot QR and session filter | 3–4 |
| 4 Hardening and pilot | Moderation, retention cron and soft delete, audit, security tests, release gates, pilot event | 4–5 |
| **Total** | | **17–24** |

The booth encoder adds 1–2 days to phase 2 (PR #17's estimate).

## 20. Open questions

1. Final domain name (expected `.co.nz`). It is needed before staging Access is set up
   (phase 1), but not for local development.
2. Workers plan for the account: Free unless a section 16 trigger fires. Session 18 reads the
   pilot's peak and asks you.
3. On-tablet encode time (session 08b). If p95 is over 3 s per shot, D14 is revisited with you.

Resolved:
- Spike 01: GO (2026-10-22).
- D14: the booth makes the variants; no Images binding; Workers Free. Confirmed by the user on
  2026-10-22.
- HD variant: 2560 px long edge, quality 85, which replaces v2.0's preview and full variants.
- D3: cancelled sessions do not upload.
- D9: the share token is stored retrievably.
- TLD: probably `.co.nz`. The design does not depend on it (section 4.1).
- Post-shoot QR opens the guest's session; admins can also generate an event-wide QR.
- Contact address: 34b Malvern Road, Morningside, Auckland, plus `privacy@<domain>`.
- Environments: one dedicated business account with separate staging and production
  resources (section 4.1).
