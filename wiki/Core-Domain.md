# Core Domain (`crates/photobooth-core`)

Pure Rust: no Tauri, no Android, no USB. Everything here runs and is tested on any host
(`cargo test -p photobooth-core`). It owns the camera abstraction, the session state
machine, settings, the in-memory photo store and the mock camera behind "test mode".

## Trade-offs

**`CameraId` is a newtype over a string, not an enum.** An enum would force a `match` arm
in every place that handles cameras (registry, settings, UI list, availability) each time a
backend is added, and would leak backend names into a crate that should not know them. The
newtype keeps well-known ids as associated consts (`CameraId::SONY_USB`, `DEVICE`, `TEST`)
and serializes transparently as a string. The cost: an unknown id is representable, so
callers must handle "no such camera" at lookup time (the app does; `camera_list` reports
availability rather than erroring).

**The clock is tokio's, not a custom trait.** The session only uses `tokio::time`
(`sleep_until`, `Instant`). Tests run under `#[tokio::test(start_paused = true)]`, where
virtual time auto-advances whenever every task is idle, so a full 3-photo session with
countdowns finishes in milliseconds and the assertions about *elapsed* time are exact
(e.g. "last countdown tick → capture is exactly 1 s"). A bespoke `Clock` trait would
add an abstraction that tokio already gives us for free. The mock camera also sleeps on
tokio time, so camera latency is under test control too. No test uses `sleep` on the real
clock.

**The session is an actor.** One task owns all state; the outside world talks to it through
a command channel and observes it through a `watch` (current state, for late joiners) and a
`broadcast` (every transition, in order). That makes transitions race-free without locks
and lets one `select!` wait on a command, the next tick, in-flight camera work, and camera
status changes at once. `Session::build` returns the future instead of spawning it so the
Tauri app can run it on its own runtime.

**Cancel aborts camera work instead of waiting for it.** Cancelling during arming or
capture aborts the in-flight future. For `MockCamera` that is clean (a drop guard returns
the camera to `Ready`). For a real camera, a dropped async wrapper does not stop a
blocking USB transaction already underway; the Sony backend must make `capture()`
cancellation-safe itself (the shutter drop-guard in `sony-ptp`). The alternative — wait for
the capture, then discard it — would make "Cancel" feel hung for up to a few seconds.

**Photos never touch disk.** `PhotoStore` is the only place they live; it is `Clone` (shared
`Arc<Mutex<HashMap>>`) so the session writes and the `booth://` protocol handler reads. It
is cleared on return to `Attract`, on cancel, on take-another and when a new session
starts. A restart of the app loses them by design (the camera's SD card is the archive).

**Settings validate on save *and* on load.** `patch()` merges a partial update on a clone and
only commits it if the result validates, so a rejected patch never half-applies. Saves are
write-temp → `fsync` → rename. A corrupt or out-of-range file makes `load()` fail but
`load_or_default()` falls back to defaults: a kiosk must still come up. `PatchSettings`
rejects unknown fields so a typo from the UI is an error rather than a silent no-op.

## Defaults chosen beyond the spec

| Item | Value | Why |
|------|-------|-----|
| `selected_camera` | `device` | Mirrors the old app's default |
| `headline` / `event_date` | "Sarah & Tom's Wedding" / "06.05.2026" | The old Compose placeholders, kept for visual parity |
| `test_mode.capture_delay_ms` | 300 | Fast enough for E2E, slow enough to see the "capturing" state |
| `test_mode.fail_every_n` | 0 (off) | Failures are opt-in |
| `test_mode.pattern` | `bars` (also `checker`, `gradient`) | Unknown names are rejected on save |
| Countdown / auto-return tick | 1 s (`Timings`) | The old app used 800 ms; the spec says "seconds" |
| Flash duration | 300 ms | Brief white frame between capture and the next countdown |
| Text limits | headline ≤ 80, event date ≤ 32 chars, no control chars | Keeps the strip layout sane |
| Mock connect time | 100 ms | Makes the `Connecting` status observable |
| Session ids | `<boot-nonce>-<n>` | The nonce stops a cached `booth://` URL from a previous run aliasing a new photo |

Session states add a `total` field (and `StripReview` carries `session_id` + the list of
available shot numbers) beyond the bare spec shapes, because the UI shows "photo 2 of 3"
and needs the session id to build photo URLs. `Flash` carries the `session_id` too: the photo is
stored *before* `Flash` is published (a test pins that), so the UI can start preparing it for the
strip the moment it hears about it (see "Strip photos" in `Frontend.md`).

## Start triggers

`StartTrigger` is `{ name(), async fired() }`. The session spawns one forwarder task per
registered trigger; when any fires it sends `Start`, which is honoured only in `Attract`
(or a recoverable `Error`). `TapTrigger` and `DevPanelTrigger` are `Notify`-backed.

`GestureTrigger` (`gesture.rs`) implements the same trait; the session did not change. The split:
a platform `PalmDetector` finds a palm **inside the guest's box** on one live-view frame
(`find_palm(jpeg, region) -> Option<Region>`); `PalmHold` (pure, tested) decides when a run of
sightings is "start"; `run_sampler` takes the newest frame, never queues, and publishes a
`GestureUpdate { palm, holding, hold_ms }` for the UI after every sample.

- **Hold 1200 ms, gap tolerance 500 ms** (the Kotlin app: 800 / 250). Both were changed on purpose:
  the ring needs a visible fill, and a palm that flickered out for 300 ms used to restart the
  hold. Unverified with a real hand; tune `DEFAULT_HOLD` / `DEFAULT_GAP_TOLERANCE`.
- Any palm whose centre is in the box counts, from any hand. A hand left raised cannot start a
  second session (a latch clears only once the palm has been gone longer than the tolerance).
- A detector error counts as "no palm"; the sampler ignores frames unless gestures are on and the
  session is in `Attract`.
- `Settings.start_trigger = gesture` means "a palm also starts a session"; the tap button always
  works. Default stays `tap` until it is verified on the rig.
- `Region` is a rectangle in the *unmirrored* frame, as fractions. The UI reports where the box
  is (`gesture_set_region`); until it does, the whole frame counts.

## Mock camera ("test mode")

A real backend, selectable like any other. Live view emits a 320×180 JPEG every 65 ms
(≈15 fps): a solid colour that cycles every second, with a frame counter. Capture returns
a 960×640 pattern JPEG (with the capture number drawn on it) after `capture_delay_ms`.
`MockCameraHandle` exposes `force_fail_next_capture()`, `force_slow_next_capture(ms)` (a
genuine one-shot that does not touch the persistent setting), `force_disconnect()`,
`set_config()` and `captures_attempted()`.

## Known limitations

- **No retry on a failed capture.** A failure ends in `Error{recoverable: true}`; the guest
  (or operator) starts again. Automatic retry of a single shot is a plausible later change.
- **`Error` has no timeout.** An unattended booth stays on the error screen until someone
  taps; there is no auto-return to `Attract`.
- **Cancel mid-capture can orphan a hardware operation** (see trade-offs above).
- **Live view is not driven by the session.** The UI starts/stops it via the app's
  `live_view_*` commands; the session only guarantees the camera is connected.
- **Test coverage is behavioural, not measured.** 60 unit tests cover every transition
  listed in the plan, run deterministically (30/30 repeated runs passed); no coverage
  percentage is claimed.
