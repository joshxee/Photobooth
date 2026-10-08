# Tauri Workstreams

Coordination page for the Tauri migration. See [Tauri-Migration-Plan.md](./Tauri-Migration-Plan.md)
for the reasoning. This page says **who owns which directory**, **which contracts are
shared**, and **when a piece is done**.

## Directory ownership

| Directory | Owns | Depends on |
|-----------|------|------------|
| `crates/photobooth-core` | `Camera` trait, session FSM, settings, photo store, mock camera | — (pure Rust; no Tauri/Android/USB) |
| `crates/sony-ptp` | PTP + Sony SDIO engine, `Transport` trait, replay/recording | `photobooth-core` (optional, feature `core-camera`) |
| `plugins/tauri-plugin-photobooth-camera` | Kotlin CameraX + USB host; Rust `NativeCamera`, `AndroidUsbTransport` | `photobooth-core` (optional, `core-camera`), `sony-ptp` (optional, `sony-transport`) |
| `apps/booth/src-tauri` | Tauri app crate: commands, `AppState`, `booth://` protocol, capabilities, `gen/android` | all of the above |
| `apps/booth` (frontend) | React/TS UI, `src/ipc`, Zustand store, bun toolchain | the command/event names below |
| `wiki/` | design rationale | — |

## Shared contracts

Pinned precisely in the per-step pages; the names below are the stable seams.

- **Camera trait** (`photobooth-core`): `id`, `connect`, `disconnect`, `status` (watch
  receiver), `start_live_view` (→ `FrameStream`), `stop_live_view`, `capture`
  (→ `CapturedPhoto`). Errors: `CameraError`. Ids: `CameraId::{SONY_USB, DEVICE, TEST}`.
- **Transport trait** (`sony-ptp`): `write_bulk`, `read_bulk`, `read_interrupt`, `reset`.
- **App commands:** `camera_list`, `camera_select`, `camera_connect`, `camera_disconnect`,
  `live_view_start`, `live_view_stop`, `session_start`, `session_cancel`,
  `session_take_another`, `session_return_home`, `settings_get`, `settings_set`,
  `test_inject`, `logs_recent`.
- **App events:** `camera://status`, `session://state` (session state is serde-tagged
  `{"state": "snake_case", ...}`).
- **Photo protocol:** `booth://photo/<session>/<shot>`; on Android the WebView sees
  `http://booth.localhost/photo/<session>/<shot>`. 404 once the session clears.
- **Plugin events:** `usbAttached`, `usbDetached`, `backPressed`.

## Definition of done (per piece)

- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (with the piece's
  feature set), and `cargo test` are clean — **no `allow` suppressions**.
- Frontend: `bun run typecheck`, `bun test`, `bun run build` clean.
- The piece's wiki page is written: trade-offs, defaults chosen that the spec didn't
  pin, known limitations, and (for hardware-facing pieces) an on-device checklist.
- Anything not exercised on real hardware is **labelled as such** in the wiki page. No
  claimed coverage percentages.

## Rules that cut across pieces

- Photos are never written to disk by any crate (only `PhotoStore`, in memory).
- Commands are least-privilege: `test_inject` and `logs_recent` are reachable only via the
  `dev` capability, never in a release build.
- Hard-code `Wry`; do not make commands generic over `R: Runtime`.
