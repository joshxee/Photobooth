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

**Originals never touch the booth's disk; the outbox is a transit buffer.** The camera's SD
card is the archive, as before. `PhotoStore` holds the captured originals for the UI only; it
is `Clone` (shared `Arc<Mutex<HashMap>>`) so the session writes and the `booth://` protocol
handler reads. It is cleared on return to `Attract`, on cancel, on take-another and when a new
session starts, and a restart loses it by design. The one thing written to disk is the portal
outbox (`outbox`, see [Booth-Upload.md](./Booth-Upload.md)): for a *completed*, non-test
session, two booth-made variants per shot (thumb and HD, no metadata, DESIGN D14) plus a small
record, deleted as soon as the server confirms READY. Why the rule changed (DESIGN D1): live
upload has to survive a crash, an outage or a closed app, which memory can't; and holding
variants rather than originals keeps the disk footprint small (≈0.5 MB a shot, not 11–17 MB)
and means a booth never stores more than the server would publish. The rule is now "nothing
is kept on the booth after the server confirms it". The outbox never evicts to make room; the
operator is warned below 1 GB free.

**The completion hook gets owned bytes.** On entering `StripReview` the session hands the
shots to `SessionContext::completion_hook` as `Bytes` clones with their metadata, not as store
keys, because "take another" clears the store while the hook may still be encoding. The
session never calls it for a cancelled or failed session, or for `CameraId::TEST`.

**The variant encoder's guarantees are the portal's rules.** `variants::encode_variants` turns
a camera JPEG into the thumb (fit 480 px, q75) and HD (fit 2560 px, q85) the outbox stores
(DESIGN D14). What callers can rely on: the EXIF orientation is applied to the pixels (all 8
values; missing or invalid means 1) and `EncodedShot.width`/`height` are the upright HD size;
nothing from the input's headers is copied (no EXIF, GPS, serial numbers, XMP, IPTC, ICC, MPF
or comments), so each output is SOI, APP0 JFIF, SOF0, DQT, DHT, one SOS and EOI; images are
never upscaled. Every output goes through `variants::check_segments`, the Worker's header
rules plus a walk of the scan, and a failure is a `VariantError`, so a variant the portal
would reject never reaches the outbox. It is plain blocking CPU work (about half a second per
24 MP shot on the tablet), so callers run it off the async workers. The crate choice and the
numbers are in [Booth-Upload.md](./Booth-Upload.md).

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
  hold. A real palm started a session on the tablet (2026-10-14); the values were not tuned beyond
  that, and false starts were not tried. Tune `DEFAULT_HOLD` / `DEFAULT_GAP_TOLERANCE` if needed.
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
