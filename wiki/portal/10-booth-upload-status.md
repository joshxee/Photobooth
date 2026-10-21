# 10 — Booth upload loop and operator status (critical)

**Goal:** completed sessions flow from the camera to READY on the portal live, survive offline
periods and app kills, and the operator can see and act on the queue.

- **Depends on:** 06, 09. The device run needs 07 (staging).
- **Unlocks:** 13.
- **Device check:** **critical**. The agent runs the automated gate; then you do a manual
  once-over.

## Read first
- DESIGN.md §9.3, §10 items 3 and 5, §15 (event-day runbook), §17 (release gate 2).
- `wiki/Booth-Upload.md`, `wiki/Tauri-App.md` (state, runtime, events), `wiki/Frontend.md`.
- `apps/booth/src-tauri/src/state.rs`, `lib.rs`.

## Scope
1. **Wire up the outbox:**
   - `AppState` opens the outbox at `{app_data}/outbox` on startup.
   - The `OnSessionComplete` hook enqueues each shot's bytes from `PhotoStore` at
     `StripReview`. Do it off the UI path; enqueue must not delay the review screen.
   - Test mode is never enqueued.
2. **Drain task** on the Tauri runtime:
   - It runs while enrolled. It wakes on enqueue, on backoff timers and on network-change
     hints if cheap; otherwise it polls every 30 s while the queue is non-empty.
   - It stops cleanly on shutdown and at most 2 uploads run concurrently.
   - A revoked device (401/403) pauses the loop and raises a clear operator error.
3. **Event `portal://outbox`** emitting `stats()` changes.
   - Command `outbox_items`: the needs-attention list with reasons; no image bytes over IPC.
   - Commands `outbox_retry{id}` and `outbox_dismiss{id}` (confirmation in the UI; dismiss
     deletes the local copy, and the SD card still has it).
4. **Operator status UI:**
   - A small, unobtrusive status-bar badge (queued / uploading / needs attention / offline)
     outside the guest-facing flow.
   - A Settings panel with the needs-attention list and retry and dismiss actions.
   - A low-disk warning below 1 GB.
   - Guest screens do not change in this session.
5. **Logging:** outbox transitions at info level, with IDs only and never bytes or the
   credential, visible through `logs_recent`.

## Out of scope
- The post-shoot QR and guest copy (13). Admin UI views of backlog (14).

## Verify
```bash
cargo fmt --all -- --check && cargo clippy -p photobooth --all-targets -- -D warnings && cargo test -p photobooth -p photobooth-core
cd apps/booth && bun run typecheck && bun test && bun run build
```
**Automated device gate** (agent, staging, Sony or test camera — note that test mode never
uploads, so use the real camera or a debug-only "upload test mode" flag in the dev capability
**only if** needed. Prefer the real camera):
1. Enrol and select a fresh staging event. Run 10 sessions, i.e. 30 shots.
2. Mid-run: airplane mode (`adb shell cmd connectivity airplane-mode enable`) for at least
   5 minutes while shooting continues, and `am force-stop` once while items are queued.
   Relaunch, then disable airplane mode.
3. Assert via the staging admin API that exactly 30 READY photos have the correct event and
   session IDs and no duplicates. Assert the outbox directory is empty (`run-as … ls`).
   Attach the logcat excerpt and screenshots of the status badge in each state.
4. Revoke the device mid-run: the operator error appears, items are kept, and re-enrolling
   resumes them.

**Human once-over** (you, about 10 minutes): run 3 sessions on the tablet, check the badge,
pull Wi-Fi briefly, kill the app once, and confirm everything arrives. Tick it in PROGRESS.md.

## Done when
- [ ] The automated gate passes, with evidence in the PR.
- [ ] The human once-over is ticked.
- [ ] Cancelled sessions and test mode are verified as not uploaded (a test plus one manual
      cancel during the once-over).

## Hand-off
- `wiki/Booth-Upload.md`: the drain loop's design, concurrency, what the operator sees and why,
  and the airplane-mode and kill results with their limits ("not tested: multi-hour offline,
  full disk").
- `wiki/Frontend.md`: the status badge and its Maestro selectors.
- PROGRESS.md entry.

