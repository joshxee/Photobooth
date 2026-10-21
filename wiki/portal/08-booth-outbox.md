# 08 — Booth outbox (pure Rust)

**Goal:** a durable, crash-safe outbox in `photobooth-core`. It accepts completed shots, keeps
them on disk only until the server confirms READY, and runs the retry state machine behind a
`PortalClient` trait. There is no HTTP and no Tauri in this session.

- **Depends on:** 03 (contract and error codes).
- **Unlocks:** 09.
- **Device check:** automated (a short tablet run proving the outbox directory is created in
  app-private storage and survives an app kill; see Verify).

## Read first
- DESIGN.md §3 (D1, D3), §9.3 (booth error handling), §10 item 3 (outbox), §14 (outbox
  retention).
- `wiki/Core-Domain.md` (especially "Photos never touch disk" and the settings
  write-temp → `fsync` → rename pattern), and `crates/photobooth-core/src/photo_store.rs`,
  `session.rs` and `settings.rs`.
- `apps/portal/contract/fixtures/device.*` and the error codes in `wiki/Portal.md`.

## Scope
1. **`crates/photobooth-core/src/outbox/`:**
   - `OutboxItem`: `client_photo_id` (UUID), `event_id`, `session_id`, `shot`, `captured_at`,
     `bytes`, `sha256`, state (`Queued | Uploading | NeedsAttention{reason}`), `attempts`,
     `next_attempt_at`, `last_error`.
   - `Outbox::open(dir)`: scans `*.json` and `*.jpg` pairs. Partial pairs and temp files are
     handled deterministically: orphan temp files are deleted, and a JPEG without its record is
     quarantined as needs attention, never silently deleted.
   - `enqueue(event_id, session_id, shot, jpeg)`: computes sha256, writes the JPEG and then the
     record, each via temp → `fsync` → rename, and `fsync`s the directory.
   - `next_due(now)`, `mark_ready(id)` (deletes both files), `mark_retry(id, err, retry_after)`
     with jittered exponential backoff (1 s → 5 min cap), and
     `mark_needs_attention(id, reason)`, `retry(id)`, `dismiss(id)`.
   - Pick a concrete jitter source and make it injectable for tests.
   - `stats()`: queued, uploading, needs-attention counts, plus free bytes from a small trait
     so tests can fake low disk.
   - `PortalClient` trait (async): `intent(item) -> IntentOutcome` and
     `upload(descriptor, bytes) -> UploadOutcome`, with outcome enums mapped from the contract
     error codes.
   - `drain_once(client, now)`: uploads at most 2 items concurrently and applies the §9.3
     table exactly:
     - network, 429, 5xx, 202 → retry;
     - `upload_expired` → re-intent;
     - `hash_mismatch` → retry, at most 3 times;
     - 401/403, `event_closed`, `photo_limit`, `invalid_image`, `conflict` → needs attention.
2. **Session integration point** (still in core):
   - When the FSM reaches `StripReview`, hand that session's shots to an `OnSessionComplete`
     hook. The hook does nothing if no event is selected or the camera is the mock/test camera.
   - Cancelled sessions never reach it; add a test proving that.
   - `PhotoStore` stays as it is: in memory, for the UI.
3. **Docs:** update the "Photos never touch disk" section of `wiki/Core-Domain.md` to the new
   rule: the SD card is still the archive, and the outbox is a transit buffer that deletes on
   READY.

## Out of scope
- reqwest, Tauri commands, UI and enrolment (09–10).
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
- READY deleting both files;
- each §9.3 row;
- `Retry-After` honoured;
- backoff cap;
- at most 2 concurrent uploads;
- low-disk stat;
- cancelled and test-mode sessions not enqueued;
- an event switch keeping old items' `event_id`.

Device (automated, after 09 wires it in, or now with a debug-only command if trivial):
document the adb steps (`run-as <pkg> ls files/outbox`, `am force-stop`, relaunch). The real
run happens in 10.

## Done when
- [ ] All the tests above pass with no suppressions.
- [ ] `Core-Domain.md` has the updated retention rule and its reasoning.

## Hand-off
- Create `wiki/Booth-Upload.md`: outbox format and durability reasoning, the retry table, why
  only completed sessions are queued, and why there is no background service.
- PROGRESS.md entry.

