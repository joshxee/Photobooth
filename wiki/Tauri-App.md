# Tauri App (`apps/booth/src-tauri`)

The Rust side of the booth: it owns every decision and exposes a small, capability-gated command
surface to the WebView. Business logic lives in [`photobooth-core`](./Core-Domain.md); this crate
wires it to Tauri, the camera plugin and the frontend.

## State flow

```
WebView ── invoke ──► commands.rs (thin) ──► AppState ──► photobooth-core
   ▲                                            │             Session (actor) · Settings · PhotoStore
   │  session://state   ◄── broadcast ◄─────────┤             Camera impls (test · device · sony_usb)
   │  camera://status   ◄── watch (per camera) ◄┘
   └── <img src="booth://photo/<session>/<shot>"> ◄── protocol.rs ◄── PhotoStore (memory only)
```

- **Commands** (`camera_list/select/connect/disconnect`, `live_view_start/stop`,
  `session_start/cancel/take_another/return_home/state`, `settings_get/set`, plus dev-only
  `test_inject`, `logs_recent`) are one-line wrappers over `AppState` methods. `AppState` has no
  Tauri types in it, so everything the commands do is unit-tested directly (32 tests).
- **Events:** `session://state` carries the serde-tagged `SessionState` on every transition;
  `camera://status` carries `{camera, status}`. A forwarder task per source re-emits them; if the
  session forwarder lags, it re-sends the *current* state rather than a stale one.
- **A guest tap** is a `TapTrigger`, a developer-panel start is a `DevPanelTrigger`; both feed
  the same `StartTrigger` seam the session already listens to, which is where a future gesture
  trigger will plug in.
- **Camera selection** is refused mid-session, persists to `settings.json`, and releases the
  previous camera. Cameras that cannot be used are listed with a **reason** (`available: false`),
  never as an error: on desktop only the test camera works; on Android the Sony card becomes
  available when a Sony USB device is attached.

## Why Channels, not events, for frames

Events are JSON strings broadcast through the webview's eval path; a 15 fps JPEG stream through
them means base64, a copy per frame, and no back-pressure. A `tauri::ipc::Channel` with
`InvokeResponseBody::Raw` delivers the bytes as an `ArrayBuffer` with ordered delivery and no
encoding. The backend forwarder additionally keeps **only the newest frame** when frames queue
up (`forward_frames`), and the frontend painter drops stale frames while a decode is in flight, so
latency cannot grow without bound. Events remain right for the small, infrequent state messages.

## The `booth://` protocol

Photos are served from the in-memory `PhotoStore` only (the no-retention rule): there is no asset
protocol and no file on disk. The WebView sees different URL shapes per platform, so
`parse_photo_url` accepts all of them:

| Platform | URL |
|----------|-----|
| macOS / Linux | `booth://localhost/photo/<session>/<shot>` (also `booth://photo/...`) |
| Windows / Android | `http://booth.localhost/photo/<session>/<shot>` (also `https`) |

Anything else — a wrong host, a non-`u8` shot, extra segments — is a 404, as is any photo after
its session was cleared. Responses carry `Cache-Control: no-store`. Session ids include a
per-boot nonce so a cached URL from a previous run can never alias a new photo. The handler uses
the current `register_uri_scheme_protocol` signature (a `UriSchemeContext`, not a bare
`AppHandle`).

## Trade-off: concrete `Wry`, not generic over `R: Runtime`

`AppState` and the commands hard-code the default runtime. Making them generic looks cleaner but
reliably fails inside `generate_handler!` with `E0283` (type annotations needed) unless `run()`
itself is generic, which it is not for a normal app. The cost is that the commands cannot run on
`tauri::test::mock_builder`; the compensation is that all logic sits in Tauri-free, separately
tested code (`AppState`, DTO conversions, the log ring buffer, `parse_photo_url`). Note
`tauri::Manager` must be imported explicitly to call `AppHandle::path()` and friends.

## Logging

`tracing` feeds a **ring buffer** (last 500 lines, served by `logs_recent`) and the console
(stderr on desktop, **logcat** on Android — `adb logcat -s Photobooth`). `tracing_subscriber`'s fmt
writer may call `write()` several times per event, so each event's writer accumulates privately and
records a line only at a newline; keeping the partial text per writer (not in the shared buffer)
is what stops pieces from different threads interleaving (found by a concurrency test).

## Security posture

- CSP `default-src 'self'; img-src 'self' booth: http://booth.localhost blob:; connect-src ipc:
  http://ipc.localhost; style-src 'self'`; the asset protocol is disabled.
- `build.rs` lists the commands; `capabilities/default.json` grants the guest-facing ones plus the
  plugin's tiny default set. `capabilities/dev.json` (`test_inject`, `logs_recent`) is referenced
  only by `tauri.dev.conf.json`, so a release build never exposes fault injection and the dev
  panel never appears.
- The camera/USB plugin commands are **not** exposed to the WebView at all.

## Verified, and not

Verified on Windows (WebView2) with the test camera by driving the real app: camera picker →
live view → complete 3-shot sessions → photos over `booth://` → injected capture failure and
recovery → injected disconnect and retry → settings persisted to disk.

**Capability gating was tested on a release-style binary** (`tauri build --debug --no-bundle`,
default capability only, strict production CSP), not just reasoned about:

| Probe from the WebView | Result |
|------------------------|--------|
| `settings_get`, `camera_list` | allowed |
| `test_inject`, `logs_recent` | **rejected** by Tauri ("not allowed … allow-test-inject") |
| plugin `usb_list` (a Rust-only command) | **rejected** ("Command not found") — not reachable at all |
| plugin `window_set_immersive` | allowed by capability; returns "only available on Android" on desktop |
| Dev toggle in the UI | absent |
| Geist fonts, live-view canvas, `booth://` images under the strict CSP | all work |

Android specifics are in `Android-Build.md` and `Native-Camera-Plugin.md`. **Not yet run on the
tablet:** the debug APK builds and the Kotlin plugin compiles, but the on-device checklist below
is outstanding.

## On-device acceptance checklist (10 steps)

Build with the dev capability so the panel exists: `bun x tauri android build --apk --debug --ci
--target aarch64 --config src-tauri/tauri.dev.conf.json`, then install the APK.

1. Launch: the **Select Camera** screen shows Device Camera, Sony A7 III (USB), Test Camera; the
   system bars are hidden.
2. Select **Test Camera**, **Continue →**: the attract screen shows the coloured live preview with
   an incrementing frame counter.
3. Tap **Tap to start photoshoot**: the pill fills (~3 s), then the countdown (3·2·1) shows
   "Look at the lens" and the shot pips advance.
4. Each shot flashes white; after the last, the **strip review** shows three photos, the
   "VIRTUAL PHOTO STRIP SAVED…" notice, and a "RETURNING TO PHOTOBOOTH" timer counting down.
5. The strip **auto-returns** to attract when the timer reaches 0 (default 12 s).
6. **Take another strip →** starts a fresh session with different photos.
7. Dev panel → **Fail next capture**, start: an error screen appears; **Try again** recovers.
8. Dev panel → **Disconnect camera**: a "Camera disconnected" banner; **Retry connection**
   restores the live view. **Slow next capture (5 s)** and **Skip countdown** behave as labelled.
9. **Settings** (gear): change *Number of Photos*, relaunch the app: the value persisted;
   **Reset settings** restores defaults.
10. Hardware **Back** from the booth returns to the picker; the screen stays awake while the booth
    is open and sleeps normally after leaving it.

Then run the device-camera and Sony checklists in `Native-Camera-Plugin.md` and
`Wired-Camera-Protocol.md`.

## Known limitations

- Sony USB hot-plug **while a session is mid-way** is not handled specially: the session errors
  (recoverably) and the camera is rebuilt on the next connect.
- Settings changes apply to the *next* session, not one in progress.
- `session_state` and the `Fault` enum extend the originally listed command surface (documented in
  `Frontend.md`).
