# Photobooth Portal: MVP Solution Design (v2.1)

Status: **accepted**, no implementation yet. v2.1 applies the spike results
([spike/RESULTS.md](./spike/RESULTS.md)): the booth makes the variants (D14), the Worker stores and
checks them, and the target volume is 2,000 photos a month. **D14 awaits the user's confirmation**
(see PROGRESS.md, session 01).
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
| Base cost | about USD 0/month on Workers Free (2,000 photos/month, 90-day retention, about 2.6 GB stored); USD 5 if production moves to Workers Paid for request headroom. Budget: USD 20/month all-in |
| Effort | 16–22 engineering days, including a 1–2 day spike |

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
| D1 | **The camera's SD card stays the archive; the booth's disk is only a transit buffer.** The camera keeps running in *Still Img. Save Dest. = PC+Camera*. A shot is written to the booth's app-private outbox and deleted as soon as the server confirms READY. | The current "photos never touch disk" rule exists because the SD card already archives every shot. Live upload needs to survive crashes and outages, so the rule becomes "**nothing is kept on the booth after the server confirms it**". | Booths run without an SD card |
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
| D14 | **The booth makes the variants** (thumb 480 px q75, HD 2560 px q85, orientation applied, no metadata) in Rust; the Worker never decodes (spike Q10, option B). **Awaiting the user's confirmation.** | The Images binding keeps GPS and serial numbers whatever `metadata` is set to (Q6). It also needs Workers Paid for CPU (355–470 ms per photo against the Free 10 ms, Q11) and caps inputs at 20,000,000 bytes (Q3). Uploading 0.3–0.6 MB instead of 11–17 MB per shot is 20–40× less traffic on venue networks. Trade-off: guests' browsers decode the booth's JPEG rather than a Cloudflare re-encode. Uploads come only from enrolled, revocable devices, and the header walk limits what is stored (RESULTS.md, Q10) | Uploads from devices we don't own, or on-tablet encoding is too slow (unverified, estimated 0.6–1.6 s per shot) |

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
| hd | JPEG, fit 2560×2560, quality 85, orientation applied | 240–585 KB (mean 413 KB) |

The gallery grid uses `thumb`; the lightbox and the download use `hd`. Neither variant carries
metadata: the booth encodes without EXIF, XMP, IPTC or ICC (the camera must shoot sRGB), and the
Worker rejects any APP1, APP13 or COM segment. A fixture with GPS and serial-number EXIF verifies
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

## 9. Upload and processing

### 9.1 Flow

```
Booth                         Worker                                   D1 / R2
0 after the session completes: decode, apply EXIF orientation, encode thumb + hd without
  metadata (D14); the outbox stores the two variants, not the original
1 POST /v1/device/photos {eventId, clientPhotoId, sessionId, shot, capturedAt, width, height,
                          variants: {thumb: {bytes, sha256}, hd: {bytes, sha256}}}
                              device active? event OPEN, not deleted? sizes within caps?
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
                                     (APP0, APP2 ICC, APP14, DQT, DHT, DRI, SOF0–2), SOF size =
                                     declared size for hd / within 480 px for thumb, SOS within
                                     64 KB; else delete the object, REJECTED (422 invalid_image)
                              UPDATE photos SET <variant>_stored=1 … ;
                              UPDATE photos SET state='READY' … WHERE id=? AND state='PENDING'
                                     AND thumb_stored AND hd_stored AND event not deleted
   ◄── 201 READY (second variant)  |  200 STORED (first variant)  |  4xx/5xx
3 delete the local variants + record on READY
```

Spike numbers for step 2 (RESULTS.md): about 1 ms CPU per request, wall time p50 334 ms /
p95 449 ms for HD from Auckland. The DigestStream fallback is not needed.

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

> **This file is truncated here on `main`** (since commit 9891cbd, which added the plan): the rest
> of §9.4 and sections 10–18 are missing, including §13 (threat model and limits) and §16 (cost).
> The user knows. Spike 01's results for those sections are in
> [spike/RESULTS.md](./spike/RESULTS.md): limits under Q3, the malicious-image trade-off under
> Q10, and the cost model under Q12. With D14 there is no in-request processing left to move to
> an asynchronous path, so the question this section asked mostly falls away.

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
(`method`, `url`, `headers`, `expiresAt`). It already handles both `201 READY` and
`202 PENDING`, and recovers by re-POSTing the intent. Moving to R2 presigned URLs then needs
only server changes:
- swap the HMAC signer for SigV4 presigning;
- add an R2 object-created notification on `incoming/`, feeding a Queue consumer;
- the consumer calls the **same** `processPhoto()` function.

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
   - On reaching strip review, each shot is written to `{app_data}/outbox/{clientPhotoId}.jpg`,
     plus a `.json` record with event ID, session ID, shot, capture time, sha256, bytes, state,
     attempt count and last error.
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
  `SameSite=Lax` and `Path=/e/{publicId}`. It lasts until gallery expiry (capped at 30 days), so
  a guest returning the next day doesn't need the QR again. Each request checks `access_version`,
  so rotating the link or suspending the gallery takes effect immediately.
- **Media**:
  1. Validate the cookie.
  2. Read the event row: gallery LIVE, not deleted, not expired, version matches.
  3. Read the photo row: belongs to the event, READY, not hidden.
  4. Stream from R2. Anything unauthorised returns a generic 404.
  - Response headers: `Cache-Control: private, max-age=3600`, `X-Content-Type-Options: nosniff`.
    Downloads add `Content-Disposition: attachment; filename="<event>-<n>.jpg"`.
- **Live updates**: poll `?cursor` every 5 s (with jitter) only while the page is visible and the
  event is OPEN. New photos appear as a "N new" pill rather than shifting the grid. Thumbnails are
  lazy-loaded.
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
- **Photos**: grid by state (pending, ready, rejected), hide and unhide, delete permanently (for
  removal requests).
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
| Upload URL replay | 15-minute HMAC URL bound to photoId, bytes and sha256; a READY photo rejects further PUTs |
| Malicious or oversized image | `Content-Length` must match the declared size (≤ 20 MB); Images.info checks format and dimensions (≤ 50 MP, configurable); full re-encode; only JPEG is served |
| Denial of wallet | Rate-limiting binding on enrolment, session swap and intents; per-event photo limit; fixed variants; billing alerts |
| Browser injection | React escaping; CSP `default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'`; HSTS; `Referrer-Policy: no-referrer` |
| Secret exposure | Worker secrets (`UPLOAD_KEY`, `SESSION_KEY`) live in Wrangler secrets. Logs never include query strings, cookies, tokens or bodies. Device credentials are stored hashed. |

## 14. Privacy and retention

| Data | Retention | Enforcement |
|---|---|---|
| Published variants | 90 days after event end | Access check at expiry; daily cron prefix-deletes |
| Deleted event | 7-day undo, then purged | Daily cron |
| Incoming objects | Removed right after processing (at most 1 day) | Inline delete plus lifecycle rule |
| Booth outbox | Until READY | Outbox deletes on READY |
| SD-card originals | 90 days after event end | Operator process (custody register) |
| Audit | 90 days | Daily cron |
| D1 history | 30 days | D1 Time Travel (automatic) |

Removal requests are handled with "Delete permanently" in admin, which removes the variants
immediately, plus erasing the SD-card file. Guests see the privacy notice at the booth and in
the gallery. NZ privacy review and the hosting-location disclosure remain the business's
responsibility; Cloudflare location hints are not a residency guarantee.

## 15. Operations

- **Logs**: structured JSON (request ID, event ID, photo ID, device ID, version, outcome code)
  via Workers Observability with 7-day retention. Successful media reads are sampled.
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

## 16. Cost (USD per month, steady state at 90 days; rates as rechecked in v1.2)

| | Pilot (2k photos) | Base (10k photos) |
|---|---|---|
| Workers Paid (2 requests per photo plus gallery, within included usage) | 5.00 | 5.00 |
| R2 storage (5.7 MB per photo × 3 months; 10 GB free) | 0.36 | 2.42 |
| Images transformations (3 per photo; 5k free; USD 0.50 per 1k) | 0.50 | 12.50 |
| D1, R2 operations | 0.00 | 0.00 |
| **Total** | **≈ 5.90** | **≈ 19.90** |

Removing v1.2's 7-day recovery copy saves about USD 0.20 a month. Images is the dominant cost:
dropping the preview variant would save USD 5 a month but would make phone viewing worse.

## 17. Testing and release gates

- **Worker**: Vitest with the Cloudflare Vitest plugin (`@cloudflare/vitest-plugin`), the
  Cloudflare-recommended option.
  - Tests run inside the Workers runtime with real local D1 and R2, isolated per test file.
  - It covers both pure modules and route integration tests.
  - The Images binding sits behind a small `ImageProcessor` interface, faked in tests. Real
    fidelity is checked on **staging**.
- **Web (admin, gallery SPAs)**: `bun test` with happy-dom, as in the booth.
- **Smoke**: `scripts/smoke.ts --base <url>` runs the full device → gallery flow against
  `wrangler dev` or staging.
- **Contract**: `contract/fixtures/*.json` are parsed by zod in `bun test` and by serde in
  `cargo test` (`include_str!`).
- **Booth**: outbox unit tests (fake client, `tempfile`) covering:
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
3. Fake, truncated and oversized JPEGs are rejected. The GPS-EXIF fixture shows no metadata in
   any variant.
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
| Maintenance reconciler (stuck PENDING, orphan sweep, JobCursor) | Booth outbox retries; prefix delete on purge; lifecycle rule |
| 3 buckets, 7-day recovery copy | 1 bucket; SD card archive; 7-day event soft delete |
| 4 Workers, 3 hostnames, separate monitoring Worker | 1 Worker, 2 hostnames |
| Pairing sessions, approval phrase, polling | One-time admin-issued enrolment code |
| 30-day device credential expiry | Revocable, with last-seen monitoring. A mid-event expiry would be a self-inflicted outage. |
| Byte-quota reservation and reconciliation | Atomic per-event photo count limit plus a per-file cap |
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
| 0 Spike | R2 `sha256` put verification; Images binding on a 20 MB, 24 MP Sony JPEG (input limits, `metadata=none`, orientation, time for 3 variants); Worker upload p95 from a tablet on 4G and venue Wi-Fi; JPEG size actually received over PTP | 1–2 |
| 1 Foundation | Worker skeleton, host routing, Access JWT, D1 migrations, bucket and lifecycle, staging and production envs, CI (typecheck, test, deploy staging; production manual), admin events CRUD | 3–4 |
| 2 Live upload | Device enrolment and revoke, events API, intent and PUT processing, booth outbox, client, event selection, operator status | 5–7 |
| 3 Gallery | Guest session, gallery SPA with polling, media and download, post-shoot QR and session filter | 3–4 |
| 4 Hardening and pilot | Moderation, retention cron and soft delete, audit, security tests, release gates, pilot event | 4–5 |
| **Total** | | **16–22** |

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
