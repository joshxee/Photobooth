# Booth upload (`photobooth-core::outbox`)

How the booth gets photos to the portal: a durable outbox in the Rust core, drained through a
`PortalClient` trait. This page holds the reasons; the behaviour spec is
[DESIGN.md §9–§10](./portal/DESIGN.md). Built so far: the outbox and its retry state machine
(session 08), the variant encoder (08b), and the reqwest client, enrolment and event selection
(09), and the upload loop and operator status (10).

## What is queued, and when

- **Only completed sessions.** The session hands a session's shots to its `OnSessionComplete`
  hook (`SessionContext::completion_hook`) the moment it publishes `StripReview`, which only
  the last flash leads to. A cancelled or failed session never gets there (D3: a guest who
  cancels did not consent to sharing). Tests pin cancel mid-countdown, cancel during the last
  capture, and a capture error.
- **Never the test camera.** The session skips the hook when the camera's id is
  `CameraId::TEST`, so test-mode shots can't reach the outbox whatever the app's hook does.
- **Owned bytes, not store keys.** The hook gets `CompletedShot { shot, jpeg: Bytes, width,
  height, taken_at }`. `PhotoStore` is cleared on return to attract and on "take another",
  which can happen while the hook is still encoding; `Bytes` clones are reference counted, so
  handing them over copies nothing. A test takes another strip straight after `StripReview` and
  checks the hook still holds every shot.
- **The hook must return quickly.** It is called on the session task. Session 10's hook checks
  enrolment and the selected event (core knows neither yet), encodes with 08b off the UI path,
  then calls `Outbox::enqueue`. 08b's debug probe is another implementation of the same hook.

## Variants, not originals (D14)

The outbox stores the two variants the booth makes (`EncodedShot`: thumb 480 px q75, HD
2560 px q85, orientation applied, no metadata), never the camera's original. The original
stays in memory for the strip and on the camera's SD card, which remains the archive (D1). So
the booth's disk holds 0.25–0.62 MB per shot instead of 11–17 MB, and only until READY.

## The variant encoder (session 08b)

`photobooth-core::variants::encode_variants` makes the two variants from the in-memory camera
JPEG. Its guarantees are in [Core-Domain.md](./Core-Domain.md); this section holds the reasons.

**Why the booth makes the variants, not Cloudflare (D14).** The Images binding kept GPS and
camera/lens serial numbers whatever `metadata` was set to (spike Q6), needed Workers Paid for
its CPU (355–470 ms per photo against Free's 10 ms, Q11), and meant uploading 11–17 MB per shot
over venue networks instead of about 0.3 MB (Q10). Re-encoding the pixels on the booth drops
every metadata segment by construction, and the Worker's header walk (DESIGN §9.1) checks it
again. The cost is this encoder plus about half a second of tablet CPU per shot, off the
capture path.

**Pipeline.** Read the EXIF orientation (own small parser: one tag, every read bounds-checked),
decode with DCT scaling to the smallest of 1/1, 1/2, 1/4, 1/8 whose long edge is still at least
2560 (a 6000×4000 Sony frame decodes at 3000×2000), Lanczos3 to the HD size, drop the decoded
frame, rotate or flip HD upright, encode HD, resize HD to the thumb, encode the thumb. Sizes are
computed from the stored size, so 6000×4000 gives exactly 2560×1707 and 480×320. Nothing is
upscaled.

**Crate choice.** Measured on the PC and on the Xiaomi Pad 6 with the same inputs (the spike's
24 MP sample JPEGs, 11.3 and 17.5 MB, 6000×4000), release build, one thread, whole pipeline:

| Decoder (+ `fast_image_resize` + `jpeg-encoder`) | PC (i5-13600KF) | Xiaomi Pad 6 |
|---|---|---|
| **`jpeg-decoder` 0.3, DCT-scaled 1/2 (chosen)** | 186–224 ms | **464–541 ms** |
| `zune-jpeg` 0.4 (NEON), full decode | 213–248 ms | 536–577 ms |
| `jpeg-decoder`, full decode | 233–274 ms | 730–806 ms |
| `jpeg-decoder` with its `rayon` feature | slower than without | not run |

`zune-jpeg` decodes faster on the tablet (its NEON path), but it can't scale during decode, so
the resize then starts from 24 MP and costs more than the decode saves, and the decoded frame is
72 MB instead of 18 MB. All three crates are pure Rust and build for `aarch64-linux-android`
with only the NDK linker the app already uses. `turbojpeg` was not built: it needs a CMake build
of libjpeg-turbo for Android (and NASM on x86), which the existing Android build doesn't have;
the spike's Pillow/libjpeg-turbo numbers on the same PC (0.25–0.33 s) are its reference.
`jpeg-decoder` is used without default features (no `rayon`, which was slower here).

**Encoder settings that matter.** `jpeg-encoder` writes one scan per component when its
optimised Huffman tables are on, and the header rules refuse more than one scan, so the encoder
uses the standard tables (one interleaved scan; outputs are a few percent larger). Chroma is
4:2:0 with box-averaged samples (`ChromaSubsamplingMethod::Average`), not the crate's default
of taking the top-left pixel. No ICC profile is written (the camera shoots sRGB, DESIGN §7).

**Every output is checked.** `check_segments` applies the Worker's rules (SOI; only APP0, APP14,
DQT, DHT, DRI and exactly one 8-bit SOF0 before the scan; SOS within 64 KB) and walks the scan
too (only stuffed bytes and RSTn, so a single scan, and EOI as the last two bytes). `encode`
also checks the frame size and the portal's byte caps (thumb ≤ 200 KB, HD ≤ 3 MB). A failure is
a `VariantError`, never an upload. Inputs over 50 MP are refused before decoding, and the
decoder's own buffers are capped at 256 MB, so a strange file is an error rather than an
out-of-memory kill.

**Session 08b timed it on real captures** with a debug-only completion hook
(`variant_probe.rs`, `variant probe` log lines); session 10 replaced it with the real hook,
whose `shot encoded and queued` line carries `encode_ms`. The root `Cargo.toml` builds `jpeg-encoder`, `jpeg-decoder`,
`fast_image_resize` and `photobooth-core` at `opt-level = 3` in the dev profile, so the debug
APK times optimised code.

### Measured on the tablet (2026-10-22)

Xiaomi Pad 6, debug APK of the 08b branch, Sony A7 III over USB (PC Remote, JPEG only), 10
sessions × 3 shots driven with `adb shell input tap`, numbers from `logcat -s Photobooth`:

| Per shot (n = 30) | min | p50 | p95 | max |
|---|---|---|---|---|
| **total** | 404 ms | **420 ms** | **540 ms** | 542 ms |
| decode (scaled 1/2) | 227 | 248 | 327 | 333 |
| both resizes | 98 | 103 | 122 | 140 |
| orient | 0 | 0 | 0 | 0 |
| both encodes + checks | 69 | 72 | 78 | 83 |
| HD bytes | 278,443 | 303,701 | 327,407 | 328,485 |
| thumb bytes | 10,970 | 11,167 | 11,355 | 11,420 |

- **Gate (p95 ≤ 3 s per shot): passed.** p95 is 0.54 s, at the low end of the spike's
  0.6–1.6 s estimate, so a session's three shots take about 1.3 s in all. Every shot was
  6000×4000, orientation 1 (the camera was level), HD 2560×1707. The first shot of a session is
  the slowest (446–542 ms, against 404–453 ms for shots 2 and 3), most likely CPU frequency
  ramp-up.
- **Sony JPEG size (spike Q8):** 11,185,804–11,924,782 bytes (p50 11,456,490, mean 11.50 MB),
  6000×4000, from the `downloading the captured object` line. The camera reports width and
  height 0 in its object info; `sony-ptp` then reads the size from the JPEG header.
- **Memory**, `dumpsys meminfo` sampled every 1–2 s through one extra session: the native heap
  went from about 90 MB idle to a peak of about 175 MB, and total PSS from about 490 MB to about
  790 MB. That covers the capture, the WebView's strip review and the encode together, so it is
  not the encoder alone; the encoder's own peak is about 31 MB (the 18 MB scaled frame plus the
  13 MB HD frame).
- Only log lines left the device. Nothing was written to disk; the shots stay on the camera's
  SD card as usual.
- **Not covered:** a rotated (portrait) Sony capture on the tablet. Orientation is covered by
  the unit tests, including at 24 MP.

## Format on disk

One directory (`{app_data}/outbox`; on the tablet `/data/user/0/com.jc.photobooth.tauri/outbox`,
app-private), three files per shot:

```text
{client_photo_id}.thumb.jpg   written first
{client_photo_id}.hd.jpg
{client_photo_id}.json        written last: the record, and the commit point of an enqueue
```

- `client_photo_id` is a lowercase UUID v4 made by the booth (the server's idempotency key).
- The record is compact JSON, `{"format": 1, "item": {…}}`: event and session IDs, shot,
  capture time and `next_attempt_at` in Unix milliseconds, the HD size, each variant's byte
  count and lowercase hex sha256, the state (`queued` or `needs_attention` with a reason),
  attempts, hash-mismatch count and the last error. `Uploading` is a claim held in memory and
  is never written, so after a crash nothing is "uploading".
- `OutboxItem::captured_at_iso()` gives `capturedAt` in the contract's form
  (`2026-10-22T09:30:12.345Z`); core has no date crate, so `time.rs` formats it and tests it
  against the fixture. Capture times are truncated to milliseconds on enqueue so a record
  round-trips exactly.
- `enqueue` checks the event ID against the contract's `Id` pattern and the session ID against
  `SessionId`, so an intent can't fail validation for something the outbox could have caught.

## Durability

Every file is written `name.tmp` → `write_all` → `fsync` → rename, the same pattern as
`SettingsStore`. On top of that, the directory is `fsync`ed after the variant renames and again
after the record rename. Without the first, a filesystem may persist the record's rename before
the variants', and a power cut would leave a record naming files that don't exist. Only Unix
can open a directory for `fsync`; on Windows (the dev PC's tests) that step is a no-op.

`Outbox::open` turns whatever a crash left into a known state, and never deletes anything it
can't prove is garbage:

| Found on open | Why it happens | Result |
|---|---|---|
| `*.tmp` | Killed mid-write; only a rename commits | Deleted |
| Record and both variants | Normal | Queued (or still needs attention) |
| Record, a variant missing | Killed during the READY delete, or storage damage | Needs attention, persisted; a retry re-posts the intent, which answers READY and finishes the delete |
| Variants, no record | Killed between the variant writes and the record | Quarantined: needs attention, dismiss only |
| Unreadable record | Corruption, or a future format | Quarantined with its variants |
| Anything else | Not ours | Left alone |

READY deletes the variants first and the record last, for the same reason: a crash in between
leaves a record that a retry can resolve, rather than variants nothing can upload. A variant is
re-hashed when read for upload, so a damaged file needs attention locally instead of costing
three `hash_mismatch` round trips.

## Retry rules (DESIGN §9.3)

`drain_once(client, now)` claims due items oldest capture first and runs **at most two at
once** (two workers pulling from the queue, joined with `tokio::join!`: no spawning, no extra
dependency, and a slow item doesn't hold a slot hostage). Per item: POST the intent, PUT each
variant it returned (only the ones the server still needs), delete on READY.

| Answer | Outbox |
|---|---|
| Intent READY, or an upload 201 READY | Delete the three files |
| Upload 200 STORED | Go on to the next variant; if all are stored and none said READY, ask again |
| Intent REJECTED | Needs attention, with the server's reason |
| Network error, 429, 5xx, 408, upload 202 | Retry with backoff, honouring `Retry-After` |
| 410 `upload_expired` | Re-POST the intent at once (same `clientPhotoId`) for fresh URLs |
| 422 `hash_mismatch` | Retry with backoff, at most 3 times; the 4th needs attention |
| 401 (intent or PUT) | The device is refused: the pass stops, the item stays queued untouched, and the loop pauses until the booth is enrolled again (session 10) |
| 403, 409 (`conflict`, `event_closed`, `photo_limit`), 422 `invalid_image`, 400, 404, 413 | Needs attention |

- The contract code decides when the body has one; a body without one (a proxy's 502 page) is
  mapped on status alone. `ErrorCode` lists the closed set, and a test checks every
  `error.body.*` fixture's code and manifest status against it, so a contract change that adds
  or moves a code fails `cargo test` until this table follows.
- An item makes at most 3 intents per pass (`MAX_INTENTS_PER_ATTEMPT`), so a server that keeps
  expiring URLs or never reaches READY drops to backoff instead of spinning.
- **Backoff:** retry *n* waits a step of `1 s × 2^(n−1)`, capped at 5 min, jittered down to
  between half and all of the step ("equal jitter"): never instant, never over the cap, and
  booths that went offline together don't retry in lockstep. A `Retry-After` longer than the
  backoff wins, up to an hour (`MAX_RETRY_AFTER`), so one bad header can't park an item for
  days. Failed items get their next time from the pass's `now`, so one pass never retries an
  item twice.
- **Jitter source:** xorshift64\* seeded once from the OS RNG through `uuid`'s v4 generator
  (`RandomJitter`). It only spreads retries; it needs no cryptographic strength, and it avoids a
  `rand` dependency. `OutboxOptions` injects `FixedJitter` in tests.
- Needs attention is never retried automatically. The operator's **retry** requeues the item
  due at once with the backoff and hash count reset; **dismiss** deletes its files (after a
  confirmation in the UI, session 10; the SD card still has the original). A quarantined set
  can only be dismissed, since nothing knows its event.
- An event switch never moves queued items: `event_id` is fixed in each record at enqueue.

## Operator status inputs

`stats()` returns queued, uploading and needs-attention counts (quarantined sets count as
needs attention) and free bytes from a `DiskSpace` trait. `low_disk` is true below 1 GB
(`LOW_DISK_BYTES`, DESIGN §10); nothing is ever evicted to make room. Core ships only
`UnknownDiskSpace` (free space unknown, never "low"): reading free space needs a platform call
(`statvfs` or Android `StatFs`) and therefore a dependency, which belongs to the app in
session 10.

## Why there is no background service

The booth is a kiosk app that runs for the whole event (DESIGN §10). Draining only while it
runs keeps the outbox one process with one owner, and needs no Android foreground service,
WorkManager job or battery-optimisation exemption. Anything left when the app closes is still
on disk and drains at the next start; the SD card has every original regardless.

## The portal client, enrolment and event selection (session 09)

Code: `apps/booth/src-tauri/src/portal/` (`types.rs`, `client.rs`, `credential.rs`,
`service.rs`); the app-level glue is in `state.rs` (`portal_*`), the operator UI in
`src/screens/PortalSettings.tsx`.

### How the contract fixtures are consumed

`portal/types.rs` has one serde type per device message. Its test compiles in every
`apps/portal/contract/fixtures/device.*.json` with `include_str!`, looks up each file's schema
in `contract/manifest.json`, parses it as the matching Rust type and serializes it back: the
JSON must be identical. That catches a field the Rust type lacks or renames, and a `null`
written where the contract omits an optional field. A second test fails if a `device.*`
fixture is added to the directory or the manifest without a line in the test, so a contract
change can't slip past `cargo test`. Response types don't `deny_unknown_fields` (a deployed
booth must survive a server that adds a field); request types do. Statuses (`uploadStatus`,
`galleryStatus`) stay strings for the same reason. The client tests answer from the same
fixtures (`error.body.*` for errors) through a ~100-line HTTP/1.1 server on 127.0.0.1
(`portal/test_server.rs`): hand-rolled rather than a mock-server crate, which would add a
dependency tree for tests that need one request at a time.

### `HttpPortalClient`

- **The bearer goes only to the enrolled origin**, and only on the authenticated routes
  (events, event detail, intent). The URL is built from the stored origin and checked again
  before the header is attached (`authed`), so a path that resolves elsewhere is refused.
  Enrolment and the upload PUTs never carry it: a PUT sends exactly `uploads.<variant>.headers`
  (an open map, so presigned URLs can add headers later, DESIGN §9.4) and nothing of ours.
  `X-Outbox-Depth` and `X-App-Version` go with the authenticated calls only (session 05).
- **No redirects at all.** The API never redirects, and a followed redirect is where a
  credential or a signed URL leaks to another host. A 3xx is retried like a network
  error rather than parked as needing attention: on plain http a captive portal redirects
  to its login page.
- **An https portal never uploads over http**, whatever URL the intent returns.
- **Errors never contain a URL**: reqwest's messages quote it, and PUT URLs carry their
  signature, which would land in `last_error` and the logs. The client reports the root cause
  only ("could not connect: …").
- **A 2xx the client can't parse is retried like a network error.** On venue Wi-Fi the usual
  cause is a captive portal answering every request with its login page. For the PUT, status
  and body must agree (200 STORED, 201 READY, 202 PROCESSING); a 200 HTML page is never
  "stored".
- Responses are read with a 256 KB cap; timeouts are 10 s to connect, 30 s per API call and
  120 s per PUT (3 MB on slow Wi-Fi).
- **TLS: rustls on `ring` with the Mozilla roots (webpki-roots)**, passed to reqwest 0.13 as a
  preconfigured config. reqwest's own `rustls` feature uses aws-lc-rs (cmake and NASM to
  cross-compile for Android) and `rustls-platform-verifier`, which needs JNI initialisation
  from the Android side. The cost of webpki-roots: the root list is what the build shipped
  with, not the tablet's trust store, so a new CA needs an app update. Cloudflare's
  certificates chain to long-lived public roots, so this is acceptable for a kiosk app that is
  rebuilt regularly. (`rustls-no-provider` still compiles the platform verifier and its JNI
  crate; nothing calls it.)

### The credential: where it lives and the limits

The enrolment response's credential (256 bits, base64url) is written to
`{app_data}/portal-credential.json`, its own file next to `settings.json`: temp file created
with mode 0600, `fsync`, rename. It holds the portal origin it was issued for, the device ID
and name, and the credential. It is **never** in the settings JSON, never in an IPC payload
(the WebView sees `PortalStatus`: enrolled, host, device name, event) and never logged:
`DeviceCredential` has no `Display` and a redacted `Debug`, a damaged file's parse error is
dropped rather than quoted, and the bearer `HeaderValue` is marked sensitive. A test enrols,
lists and selects against the mock portal with a TRACE-level log capture and checks that the
secret appears in the credential file and the `Authorization` header only.

Limits: the file is protected by Android's per-app sandbox (`/data/user/0/<package>`), so
anyone with root or a debuggable build's `run-as` can read it. That is accepted for the MVP
(DESIGN §10, §13): the real controls are revocation in the admin portal and last-seen
monitoring. Wrapping it with an Android Keystore key through the Kotlin plugin is post-MVP.

### Portal address rules

The operator types the portal's address. `https://` is required, except plain `http` for
`localhost`, `*.localhost` and loopback addresses (local `wrangler dev`), and, in **debug
builds only**, private IPv4 addresses so the tablet can reach a dev PC on the LAN. Only an
origin is accepted (no path, query, fragment or user info). Debug builds start the form at
`http://photos.localhost:8787`; release builds start empty until sessions 07/18 settle the
hosts (`PHOTOBOOTH_PORTAL_URL` at build time overrides both).

### Enrolment and event selection, and why they work this way

- **Portal changes run one at a time** (`AppState::portal_ops`), each together with its
  settings write, so a double tap can't enrol twice and an unenrol can't slip between an
  event check and saving the selection.
- **Enrolment is refused while enrolled.** The operator unenrols first (behind a
  confirmation), so a credential is never replaced by a mistyped code. A revoked booth gets
  "Unenrol, then enrol again with a new code" on its next call (any 401 outside enrolment).
- **Selecting an event re-fetches it** (`GET /v1/device/events/{id}`) and accepts it only if
  `uploadStatus` is `OPEN` now: the list may be minutes old, and the detail route returns
  CLOSED and DRAFT events too.
- **A confirmation screen names the event and its local date** and says "Photos from this
  booth will appear in this event's gallery": the operator is choosing where guests' photos
  go, and two events on consecutive days at one venue look alike in a list. Switching says
  which event it replaces and that photos already taken stay with their event (each outbox
  record carries its `event_id` from enqueue).
- The selected event and the portal address live in the settings (validated there; a
  `settings_set` patch can't change them, and a settings reset keeps them). Unenrolling clears
  the event; the address is kept for the next enrolment.
- The camera picker (the operator's landing screen) shows a status line: the event and its
  date, "no event selected (photos stay on the SD card)", or "not enrolled". Clearing the
  event has its own confirmation too, since it stops uploads; removing a damaged enrolment
  does not, because a damaged credential can't upload anything anyway. The upload badge
  sits beside it (session 10).

## The upload loop and operator status (session 10)

Code: `apps/booth/src-tauri/src/upload/` (`hook.rs`, `pump.rs`, `mod.rs`, `disk.rs`), wired in
`lib.rs` and `state.rs`; the operator UI is `src/screens/UploadQueue.tsx` and the badge on the
camera picker (`src/screens/uploadText.ts`).

### Where encoding runs, and why

- The session hands a completed session to `EncodeAndQueue` (`OnSessionComplete`) on the session
  task. The hook only reads the selected event (settings, in memory) and sends the session down
  a channel, so the review screen never waits; a test blocks the encoder and checks the hook
  returns at once. The test camera is refused here too (the session already skips it).
- One `outbox-encoder` thread takes sessions in order and, per shot: checks the booth is still
  enrolled (it reads the credential file, so not on the session task), encodes with 08b,
  `enqueue`s, and nudges the upload loop. One shot at a time keeps peak memory at one decode
  (08b measured ≈ 175 MB native heap at peak) and leaves CPU for the live view. The channel is
  unbounded: dropping a completed session is worse than queueing one, and a session takes tens
  of seconds while its encode takes about a second.
- The event is the one selected **when the session completes**; an event switch later never
  moves it (the record carries it). Nothing is encoded without an event and an enrolment.
- An encode or enqueue failure is logged with the session ID and shot and added once to the
  needs-attention list as a "not queued" entry (memory only, dismiss to acknowledge): guest
  screens can't show it, and the camera's SD card has the original anyway.
- Originals never reach the disk: the hook holds the session's own `Bytes` and only the
  variants are written. On the tablet the outbox held only `*.thumb.jpg`, `*.hd.jpg` and
  `*.json` while items were queued.

### The drain loop

- **Its own thread and runtime** (`outbox-upload`, a current-thread tokio runtime) with **its own
  reqwest client**, because `drain_once` reads variants and `fsync`s records inline (08's
  review). One loop means one `drain_once` at a time, which is what keeps uploads at **two at
  once**; a test runs 12 shots arriving during passes and sees at most two in flight.
- **Wakes on**: an enqueue or an operator retry (a `Notify` permit, so a nudge during a pass
  isn't lost), the earliest item's backoff, an enrolment or unenrolment, and at least every
  **30 s** while items wait. It asks `PortalService` for a client before every pass, so an
  unenrolment takes effect at once; not enrolled, it sleeps until nudged.
- **Offline**: a pass whose only outcomes were network failures (no HTTP answer, or a captive
  portal's page) sets `offline`. There is no network-change hint (that would need Android's
  `ConnectivityManager` through the plugin). Instead, while offline, each 30 s poll brings the
  oldest waiting item forward as a probe (`expedite_next`), and the first pass that gets any
  answer brings every waiting item forward (`expedite_all`), so uploads resume within about
  30 s of the network returning rather than after a backoff of up to 5 minutes. The probe
  costs one request per 30 s while offline; a paused-clock test bounds a 10-minute outage at
  ≤ 50 intents for 3 items, and checks recovery within one poll.
- **Revoked device**: a 401 on the intent or a PUT now stops the whole pass (core
  `Action::Revoked`), hands the item back untouched (no attempt counted, still due) and pauses
  the loop for the current enrolment *epoch*. Nothing is tried with that credential again;
  the status shows `revoked`; the queue is kept. Unenrolling and enrolling again bumps the
  epoch and resumes every item. Before session 10 a 401 made each item need attention one by
  one, which would have left a revoked booth's whole backlog for the operator to retry by
  hand. A 403 stays per item: on a PUT it means the signed URL isn't valid (06), not the
  device.
- **Shutdown**: on `RunEvent::Exit` the loop stops while waiting or mid-upload; an upload in
  flight stays queued on disk (claims are memory only) and goes at the next start. On Android
  the app is usually killed instead, which the outbox's recovery covers.
- `X-Outbox-Depth` is the outbox's length (`PortalService::with_outbox_depth`); the admin
  devices list showed it as `lastBacklog` on the tablet.

### What the operator sees, and why

- **Badge** on the camera picker, beside the `Portal:` line, never on guest screens: the most
  urgent of "paused: the portal refused this booth", "N need(s) attention", "N waiting, booth
  not enrolled", "offline, N waiting", "sending, N left", "N queued", "all sent", plus
  "· storage low" below 1 GB. Nothing for an idle booth that isn't enrolled. The picker is
  the operator's landing screen, and the booth must look the same to guests whatever the
  queue is doing.
- **Settings → Upload Queue**: counts, free storage, the revoked and offline explanations, the
  low-storage warning, and the needs-attention list (stopped uploads with the server's reason,
  damaged files, shots that weren't queued). **Retry** requeues a stopped upload at once;
  **Delete…** needs a confirmation ("Delete this photo from the booth?", "The camera's SD card
  still has the original") and is refused while the item uploads. The list is re-read on every
  status change.
- **Status feed**: `portal://outbox` carries `OutboxStatus` whenever the outbox (`subscribe`)
  or the loop's facts change, and at least every 60 s for the free-space figure; it is only
  sent when it differs. `outbox_status` gives the snapshot at start-up. No image bytes or IDs
  beyond photo/session/event IDs cross IPC.
- **Free space** comes from `statvfs` on Unix/Android (`PlatformDiskSpace`); the Windows desktop
  build reports it as unknown, never low. Nothing is ever evicted to make room.
- **Logs**: every transition at info with IDs only: `session handed to the outbox`, `shot
  encoded and queued` (with `encode_ms`), `upload started`, `upload will be retried`, `upload
  needs attention` (warn), `upload confirmed READY` (with session, shot and `since_capture_ms`),
  `upload retried by the operator`, `outbox entry dismissed`, plus the loop's offline, resumed and
  refused lines. Never bytes or the credential: on the tablet the 43-character credential
  appeared 0 times in the whole logcat buffer and in `settings.json`.

### Timings and device results (session 10, 2026-10-23)

Xiaomi Pad 6, debug APK of the session branch, against `wrangler dev` on the PC through
`adb reverse tcp:8787 tcp:8787`. Android 14 resolves `photos.localhost` to 127.0.0.1, so the
debug build's default portal address works on the tablet and the Worker issues plain-http
upload URLs; this replaces session 09's "uploads from the tablet need staging". The Sony
timed out on `GetDeviceInfo` (bulk write) after being woken and the app restarted, so the run
used the tablet's **Device Camera**, a real non-test camera on the same capture → hook →
upload path. **The Sony leg is unverified** (left for the once-over).

- **Session end → READY** (the `StripReview` hand-over to the last shot's READY), online:
  1.7–2.2 s for three shots; encode 313–350 ms per shot (Device Camera JPEGs, smaller than
  the Sony's; 08b measured p95 0.54 s for the Sony's). The desktop build on the PC: 6 shots
  READY 450 ms after the first review.
- **10 sessions, 30 shots** to a fresh event: exactly 30 READY rows (30 distinct
  `clientPhotoId`s, 10 sessions, 30 distinct session/shot pairs), nothing PENDING or REJECTED,
  outbox empty, files only `*.thumb.jpg`/`*.hd.jpg`/`*.json` while queued.
- **Offline** (the tunnel removed for 5 min 46 s, Wi-Fi and adb kept up): 5 sessions shot, the
  badge read `Uploads: offline, 6 waiting` then `15 waiting`; **`am force-stop`** with 6
  queued, relaunch: `outbox opened … items=6`, offline detected on the first pass, Settings
  `Queued 6`. Tunnel restored: all 15 READY and the outbox empty 33 s later (one poll).
- **Take another at once**: tapped on the review screen 3 s after it appeared (the photo store
  was cleared); all three shots arrived.
- **Revoked mid-run**: the next session's shots stayed queued (`Queued 3`, needs attention 0),
  badge `Uploads paused: the portal refused this booth`, Settings explains it; a new device
  code, Unenrol, Enrol: the queue emptied within 3 s, with no event re-selection needed.
- **Not tested**: real airplane mode (it turns Wi-Fi off, which ends Wireless debugging and
  with it every adb command, so it needs someone at the tablet); multi-hour offline; a full
  disk; real TLS to Cloudflare (staging, 07); concurrent booths.
- **Cancel**: the booth UI has no cancel control, so a cancelled session can't be made on the
  tablet; `session_cancel` is covered by the core session tests and an app test that cancels
  mid-countdown on a non-test camera and checks nothing reaches the portal.

## The post-shoot QR code (session 13)

After a session the guest sees a QR code that opens the gallery on their own shots
(DESIGN §10 item 4). `portal/gallery.rs` holds it all.

**The gallery link is cached in memory only.** `galleryUrl` (`/e/{publicId}#k={token}`) lets
anyone holding it see the whole event, so it is never written to `settings.json`, the outbox or
the log, and `GalleryUrl` has no `Display` and a redacted `Debug`. The booth learns it:

- when an event is selected (`portal_select_event` already re-fetches the event, so the link
  comes with it, no extra request);
- from `AppState::gallery_refresher`: at start-up, every 5 minutes while an event is selected,
  and at once when the enrolment or the event changes (`GET /v1/device/events/{id}`).

A 401 (revoked) or 404 (event gone) forgets the link; a network failure, a 5xx or a 429 keeps
the last answer, because the booth may be briefly offline while the gallery is still LIVE (the
shots upload later, and the link works then). Unenrolling, enrolling and clearing the event
forget it at once. A restart forgets it too and asks again.

**The link must be on the enrolled portal's own origin** and a `/e/` path, or the booth shows
no QR code (and logs a warning without the link). A QR code on the booth is something guests
trust; a misconfigured or tampered response can't send them elsewhere.

**Why Rust renders the QR code.** The WebView never sees the link as text: it gets an SVG of
modules (`portal_session_qr`), and nothing in the WebView, its console or the dev panel's log can
leak the token. The `qrcode` crate makes the module matrix (no default features: no `image`);
the SVG is drawn here as one rectangle per horizontal run, with the 4-module white quiet zone
inside the SVG and a `viewBox` but no size, so CSS sizes it. Error correction **L**: the code is
on a screen and can't get damaged, and fewer modules make each one larger. A staging link
(about 110 characters) is version 6, 41 modules. A test draws the SVG back into pixels and reads
it with an independent decoder (`rqrr`, dev-only).

**The link for a session** is `galleryUrl` with `s={session_id}&n={shots}` appended to the
fragment, once (any `s`/`n` already there is replaced), and only for a session ID and a count
the gallery accepts (`SessionId`, 1–10). The token stays in the fragment, so a browser never
sends it to the server.

**Which session.** The completion hook tells `PostShoot` which session went to which event
with how many shots (`Destination::handed_over`). It runs on the session task just before the
review is published (session 13 moved it from just after), so the answer is ready when the UI
asks. `portal_session_qr` answers only for that last session, and only while enrolled:

| Situation | `mode` | Post-shoot screen |
|---|---|---|
| Enrolled, event selected, gallery LIVE, link known | `qr` | "Scan for your photos" + QR code |
| Enrolled, event selected, gallery not LIVE (or not heard yet) | `event_gallery` | "Looking good." + "Your photos will be in the event gallery." |
| Not enrolled, no event, test camera, or another session | `none` | As before the portal |

**The review stays up longer with a QR code.** The hook can ask the session for a longer
review (`OnSessionComplete` returns `Option<u8>`); the app asks for the new **QR Code Display
Time** setting (default 20 s, 10–60, the design's 20 s) when the session gets a QR code. The
session uses the larger of that and the strip display time, and `StripReview` now carries
`auto_return_total`, so the progress bar knows the length. Without a QR code nothing changes.

**Races closed after the review.** A refresh that was in flight while the operator changed the
event writes only if the event is still selected, checked under the same lock as the write
(`PostShoot::set_gallery_if`; the selection saves the settings before its link). A session the
encoder thread never took isn't recorded, so it can't get a QR code for shots that will never
arrive. `portal_session_qr` ignores (and doesn't log) anything that isn't a session ID. The QR
link's fragment is exactly `k`, `s` and `n` (whatever else the portal's fragment held, including
an encoded `s`, is dropped), and the gallery link must be `/e/{publicId}` as the gallery parses it.

### Device results (session 13, 2026-10-30, staging)

Xiaomi Pad 6 over Wi-Fi adb, debug APK of the branch, enrolled on
`https://portal-staging.josh-33c.workers.dev` with a code from the staging admin API (real TLS
to Cloudflare), a throwaway LIVE event, and **the Sony A7 III** as the camera (live view and
capture over USB worked first time). Six real sessions:

- **QR state:** the screenshot's QR code decodes (OpenCV, from `adb exec-out screencap`) to
  exactly `…/e/{publicId}#k={token}&s={session}&n=3`. Opened in Claude's built-in browser at
  375 × 812: the token swap, a clean `/e/{id}?s=…&n=3` address, "Your photos", 3 photos.
- **Shot-to-READY** (gate 5: `capturedAt` → `publishedAt` from the admin API, 9 shots in 3
  sessions): 5.4–12.7 s, all under 15 s. The first shot of a session waits longest because the
  booth encodes and uploads once the session completes. The booth's own `since_capture_ms` on
  READY reads about 1.5 s more (it includes the response's trip back).
- **READY-to-visible** (the session view open before the shots, with its `&n=3` placeholders,
  "0 of 3 ready"): 6.7–10.7 s, one poll of the gallery's 10 s ± 10 % fast interval.
- **Not LIVE:** gallery suspended through the admin API, app restarted (the start-up refresh):
  "Looking good." + "Your photos will be in the event gallery.", a 12 s review, no QR code.
- **No portal:** the Test Camera's session shows the original copy (`mode="none"`).
- The start-up refresh logged `gallery link updated live=true`; the token and the gallery link
  appear 0 times in 162,504 logcat lines and in no file under the app's data directory.

## Not done yet, and unverified

- The whole path ran on the tablet against `wrangler dev` on the PC (session 10, through
  `adb reverse` and `photos.localhost`; see above). Session 13 then ran it against staging:
  real TLS (webpki-roots against Cloudflare's certificate) and the Sony as the camera, 6
  sessions, all READY (see "Device results (session 13)"). Still **unverified** on Cloudflare:
  real airplane mode and the rest of session 10's staging run.
- File I/O is blocking. `drain_once` reads each variant (typically 0.25–0.62 MB, up to the
  contract's 3 MB HD cap) and writes and `fsync`s records inline, holding the outbox lock
  during each write; an `fsync` on f2fs can take tens of milliseconds. Hence `enqueue` runs on
  the encoder thread, the drain loop on its own thread and runtime, and `outbox_retry` /
  `outbox_dismiss` in `spawn_blocking` (session 10). The two-upload limit is per `drain_once`
  call, so there is exactly one loop.
- The operator's **retry** applies only to needs-attention items, and **dismiss** is refused
  while an item is uploading, so a stale or double tap can't start a second upload or delete
  files mid-PUT.
- A crash during the READY delete leaves a record whose variants are gone; it needs the
  operator's retry (the server then answers READY). Retrying it automatically was considered
  and rejected: a record missing its variants is also what storage damage looks like, and the
  rule here is that nothing changes state without either the server or the operator.
- The directory `fsync` and the crash recovery are tested on Windows and Linux (CI) by
  simulating what a kill leaves behind. A real power cut on the tablet's f2fs storage is
  **unverified**.

## Device check (session 08)

Session 08 checked recovery with a debug-only probe that opened the outbox at startup and
logged a `debug outbox probe` line (removed in session 10; every build now opens the outbox and
logs `outbox opened … items=N quarantined=N`). Steps, with adb over Wi-Fi (`AGENTS.md`, "Device
testing"):

```bash
pwsh apps/booth/scripts/build-android-debug.ps1 -Install
adb shell am start -n com.jc.photobooth.tauri/com.jc.photobooth.MainActivity
adb logcat -d -s Photobooth | grep -i outbox          # "outbox opened", "debug outbox probe"
adb shell run-as com.jc.photobooth.tauri ls -la outbox
# plant what a kill leaves behind (a temp file, variants without a record), then:
adb shell am force-stop com.jc.photobooth.tauri
adb shell am start -n com.jc.photobooth.tauri/com.jc.photobooth.MainActivity
adb shell run-as com.jc.photobooth.tauri ls -la outbox   # temp gone, the rest kept
```

Run on the Xiaomi Pad 6 on 2026-10-22 (debug build of this branch). Use PowerShell for these
commands on Windows: Git Bash rewrites `/data/...` arguments into Windows paths.

- First launch: `outbox opened dir=/data/user/0/com.jc.photobooth.tauri/outbox items=0`; the
  directory is `drwx------` and owned by the app's uid.
- Planted with `run-as`: one valid synthetic item (three files, hashes matching), a record-less
  thumb + hd pair, and a `.json.tmp`. After `am force-stop` and relaunch: `deleting an
  incomplete outbox write`, `quarantining outbox variants without a record`, `items=1
  quarantined=1`, probe `queued=1 needs_attention=1`; the temp file was gone and the other five
  files were kept. A second force-stop and relaunch gave the same state (no temp file left to
  delete). The synthetic files were removed afterwards.
- Not checked on the device: a real enqueue (no encoder or hook yet), a real power cut. The
  real capture → upload run is session 10.
