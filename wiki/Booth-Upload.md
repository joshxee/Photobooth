# Booth upload (`photobooth-core::outbox`)

How the booth gets photos to the portal: a durable outbox in the Rust core, drained through a
`PortalClient` trait. This page holds the reasons; the behaviour spec is
[DESIGN.md §9–§10](./portal/DESIGN.md). Built so far: the outbox and its retry state machine
(session 08). The variant encoder (08b), the reqwest client and enrolment (09), and the upload
loop and operator status (10) come next and extend this page.

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
| 401, 403, 409 (`conflict`, `event_closed`, `photo_limit`), 422 `invalid_image`, 400, 404, 413 | Needs attention |

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

## Not done yet, and unverified

- Nothing calls `enqueue` in the app yet: the encoder is 08b, and the hook implementation and
  upload loop are session 10. Until then the outbox exists only as tested library code plus a
  debug-build probe that opens it at startup.
- File I/O is blocking. `drain_once` reads each variant (typically 0.25–0.62 MB, up to the
  contract's 3 MB HD cap) and writes and `fsync`s records inline, holding the outbox lock
  during each write; an `fsync` on f2fs can take tens of milliseconds. Session 10 must run
  `enqueue` in `spawn_blocking` and the drain loop on its own thread or a blocking-tolerant
  runtime, not on the async workers that serve UI calls. Run one drain at a time: the
  two-upload limit is per `drain_once` call.
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

Debug builds open the outbox at startup and log a `debug outbox probe` line with its path and
counts (`apps/booth/src-tauri/src/lib.rs`). Steps, with adb over Wi-Fi (`AGENTS.md`, "Device
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
