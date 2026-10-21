# 08 — Booth outbox (pure Rust)

**Goal:** a durable, crash-safe outbox in `photobooth-core`. It accepts each completed shot as
its two booth-made variants (thumb and hd, D14; never the original), keeps them on disk only
until the server confirms READY, and runs the retry state machine behind a `PortalClient`
trait. There is no HTTP, no Tauri and no image code in this session: the variant encoder is
session 08b, which produces the `EncodedShot` type defined here.

- **Depends on:** 03 (contract and error codes).
- **Unlocks:** 08b, 09.
- **Device check:** automated (a short tablet run proving the outbox directory is created in
  app-private storage and survives an app kill; see Verify).

## Read first
- DESIGN.md §3 (D1, D3, D14), §9.1 (intent and per-variant uploads), §9.3 (booth error
  handling), §10 item 3 (outbox and variant encoding), §14 (outbox retention).
- `wiki/Core-Domain.md` (especially "Photos never touch disk" and the settings
  write-temp → `fsync` → rename pattern), and `crates/photobooth-core/src/photo_store.rs`,
  `session.rs` and `settings.rs`.
- `apps/portal/contract/fixtures/device.*` and the error codes in `wiki/Portal.md`.

## Scope
1. **`crates/photobooth-core/src/outbox/`:**
   - `EncodedShot` (the input type, produced by 08b's encoder): `thumb: Vec<u8>`,
     `hd: Vec<u8>`, and the HD `width` and `height`.
   - `OutboxItem`: `client_photo_id` (UUID), `event_id`, `session_id`, `shot`, `captured_at`,
     `width`, `height`, `thumb: {bytes, sha256}`, `hd: {bytes, sha256}`, state
     (`Queued | Uploading | NeedsAttention{reason}`), `attempts`, `next_attempt_at`,
     `last_error`.
   - Files per item: `{id}.thumb.jpg`, `{id}.hd.jpg` and `{id}.json`.
   - `Outbox::open(dir)`: scans the item files. Incomplete sets and temp files are handled
     deterministically: orphan temp files are deleted, a record whose variant file is missing is
     marked needs attention, and variant files without a record are quarantined as needs
     attention. Nothing is silently deleted.
   - `enqueue(event_id, session_id, shot, captured_at, EncodedShot)`: computes both sha256s,
     writes both variants and then the record (last), each via temp → `fsync` → rename, and
     `fsync`s the directory.
   - `next_due(now)`, `mark_ready(id)` (deletes all three files), `mark_retry(id, err, retry_after)`
     with jittered exponential backoff (1 s → 5 min cap), and
     `mark_needs_attention(id, reason)`, `retry(id)`, `dismiss(id)`.
   - Pick a concrete jitter source and make it injectable for tests.
   - `stats()`: queued, uploading, needs-attention counts, plus free bytes from a small trait
     so tests can fake low disk.
   - `PortalClient` trait (async): `intent(item) -> IntentOutcome` (`Ready`, `Rejected{reason}`
     → needs attention, or `Pending` with upload descriptors for only the variants the server
     still needs) and
     `upload(descriptor, bytes) -> UploadOutcome` (`Stored`, `Ready`, or an error), with outcome
     enums mapped from the contract error codes.
   - `drain_once(client, now)`: works on at most 2 items concurrently. Per item: intent, then
     PUT each variant it returned, then `mark_ready` on READY. It applies the §9.3 table
     exactly:
     - network, 429, 5xx, 202 → retry;
     - `upload_expired` → re-intent;
     - `hash_mismatch` → retry, at most 3 times;
     - 401/403, `event_closed`, `photo_limit`, `invalid_image`, `conflict` → needs attention.
2. **Session integration point** (still in core):
   - When the FSM reaches `StripReview`, hand that session's shots to an `OnSessionComplete`
     hook **as owned `Bytes` clones with their shot metadata**, not as `PhotoStore` keys:
     `PhotoStore` is cleared on return to attract and on "take another", which can happen while
     the hook is still working. The hook does nothing if the booth is not enrolled, no event is
     selected, or the camera is the mock/test camera. (Session 10 implements it: encode with
     08b, then `enqueue`, off the UI path.)
   - Cancelled sessions never reach it; add a test proving that.
   - `PhotoStore` stays as it is: in memory, for the UI.
3. **Docs:** update the "Photos never touch disk" section of `wiki/Core-Domain.md` to the new
   rule: the SD card is still the archive, originals never touch the booth's disk, and the
   outbox is a transit buffer of booth-made variants that deletes on READY.

## Out of scope
- The variant encoder (08b). reqwest, Tauri commands, UI and enrolment (09–10).
- A background service when the app is closed (DESIGN §10: kiosk only).

## Verify
```bash
cargo fmt --all -- --check
cargo clippy -p photobooth-core --all-targets -- -D warnings
cargo test -p photobooth-core
```
Tests must cover:
- kill-during-write simulation (a temp file present on open);
- restart preserving the queue;
- READY deleting all three files;
- a missing variant file or a missing record found on open;
- an intent that returns only the hd URL uploads only hd;
- each §9.3 row;
- `Retry-After` honoured;
- backoff cap;
- at most 2 concurrent uploads;
- low-disk stat;
- cancelled and test-mode sessions not enqueued;
- the hook still has every shot's bytes when "take another" clears `PhotoStore` straight
  after `StripReview`;
- an intent answered REJECTED becomes needs attention;
- an event switch keeping old items' `event_id`.

Device (automated, after 09 wires it in, or now with a debug-only command if trivial):
document the adb steps (`run-as <pkg> ls files/outbox`, `am force-stop`, relaunch). The real
run happens in 10.

## Done when
- [ ] All the tests above pass with no suppressions.
- [ ] `Core-Domain.md` has the updated retention rule and its reasoning.

## Hand-off
- Create `wiki/Booth-Upload.md`: outbox format and durability reasoning, why it holds variants
  and not originals (D14), the retry table, why only completed sessions are queued, and why
  there is no background service.
- PROGRESS.md entry.

