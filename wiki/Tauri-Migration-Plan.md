# Tauri Migration Plan

Status: in progress on `feature/tauri-migration`. This page is the **why** behind the
migration; per-component pages (`Core-Domain.md`, `Wired-Camera-Protocol.md`,
`Native-Camera-Plugin.md`, `Tauri-App.md`, `Frontend.md`, `Android-Build.md`) hold the
details as they land. Coordination and ownership live in
[Tauri-Workstreams.md](./Tauri-Workstreams.md).

## Executive summary

The Photobooth app is Kotlin Multiplatform + Compose Multiplatform (Android, iOS,
Desktop, Web). It is being replaced, **Android only for this first cut**, by a Tauri v2
app: a Rust core that owns all business logic, a thin React WebView for rendering, and
one Android-specific Tauri plugin for the camera hardware. The cut has three camera
modes:

1. **Wired Sony A7 III over USB** (PTP, "PC Remote" mode) — new; nothing like it existed.
2. **Native device camera** — ported (CameraX).
3. **Test mode** — a *real* in-memory mock camera with fault injection, replacing a
   "Mock Camera" that was never actually a mock.

## Audit findings (verified against source, not assumed)

| Claim | Evidence |
|-------|----------|
| No wired/USB camera mode exists in code or history | No `UsbManager`/`UsbDevice`/PTP/libusb reference in `composeApp/src` or `iosApp`; `git log --all -S"UsbManager"` is empty. The only external camera is `CameraType.SONY_A7III_MARK2` ("WiFi Transfer") — `camera/domain/CameraType.kt:8`. |
| The only external camera is Sony over **Wi-Fi** JSON-RPC at `192.168.122.1:10000` | `camera/data/sony/SonyA7IIICamera.kt:21-22`, `SonyCameraApiClient.kt:70-71`; cleartext allow-list in `androidMain/res/xml/network_security_config.xml:6`. |
| "Mock Camera" is not a mock | `App.kt:65` routes `CameraType.MOCK_CAMERA -> Screen.PHOTOBOOTH_NATIVE`, i.e. the real CameraX screen, which requests the CAMERA permission (`NativePhotoboothScreen.android.kt:60-86`). `CameraRepository.getCameraInstance` *throws* for mock (`CameraRepository.kt:63-66`). The real mock classes (`MockCameraController`, `MockCameraConfig`) live only in `commonTest`. |
| Several wiki pages describe deleted code | Commit `192b1a1` ("delete Mark 1 Sony photobooth path + Knockbox UI migration", 75 files, +4874/−3509) removed the view-models and screens those pages describe. `Camera-System.md`, `Architecture.md`, `State-Management.md`, `Testing-Strategy.md` are **unreliable**; verify against source. |
| Photos are never saved to disk | No `MediaStore`/`FileOutputStream`/`getExternalFilesDir` usage in `commonMain` or `androidMain`. Photos live in memory for one session. |
| Gesture start exists for the Sony Wi-Fi path only | `androidMain/.../gesture/MediaPipeGestureDetector.kt` (MediaPipe `GestureRecognizer`, `Open_Palm`), consumed by `SonyMark2ViewModel`. |

## Decisions (made; do not re-litigate)

- **Scope:** Android only. Dropped: Sony Wi-Fi mode, the Sony API-discovery dev tool,
  Wi-Fi/network monitoring, kiosk device-owner pinning, iOS/JVM/JS/Wasm targets.
- **Rust core owns the business logic** (session FSM, camera orchestration, settings,
  photo store). The WebView is the least-trusted render layer; every IPC command is
  capability-gated and least-privilege.
- **Wired camera = PTP over USB**, camera in PC Remote mode. The protocol engine is
  transport-agnostic (`Transport` trait) so the same code runs over desktop `rusb` and
  an Android USB file descriptor handed from Kotlin to Rust.
- **Native camera = CameraX preview behind a transparent WebView** (the pattern of
  Tauri's official `barcode-scanner` plugin), not `getUserMedia`. Capture quality and
  EXIF stay under native control, and the camera stays in the trusted process.
- **No app-side photo retention.** The camera's SD card is the only archive. The current
  session's JPEGs are held in memory only, served to the WebView over a `booth://`
  protocol, and cleared when returning to the attract screen. Never write photos to
  app storage.
- **Gesture (open-palm) start is deferred.** A `StartTrigger` seam in the session FSM is
  reserved for it. Original behaviour to restore later: MediaPipe `GestureRecognizer`,
  2 hands, 0.4 confidence, `Open_Palm`, 800 ms hold, 250 ms gap tolerance, 3 s idle
  reset.
- **Frontend:** React 19 + TypeScript on a **bun-only** toolchain (package manager,
  `Bun.build`, `Bun.serve` + HMR, `bun test` + happy-dom). Vite is the sanctioned
  fallback if bun's dev server proves unworkable; switching must be noted, never a
  silent fall back to npm.
- **Testing, three tiers only:** unit (`cargo test`, `bun test`); E2E (Maestro on the
  real tablet with **test mode** as the default camera for determinism); a manual
  on-the-rig checklist. No coverage percentages are claimed.
  *Amended 2026-10-09:* on the Xiaomi Pad, Maestro cannot run unattended: its helper app triggers
  an "Install via USB" prompt on the tablet (10 s auto-deny) and someone has to tap it on **every**
  run. So **local testing on that tablet favours plain adb** (`screencap`, `input tap/keyevent`,
  `am start`, `uiautomator dump`, `logcat`, `run-as`), which needs no prompt. Maestro stays the
  E2E tier for CI and emulators/virtual devices, where that prompt is not expected (not yet tried
  there, and not yet wired into CI).

## Architecture

```
apps/booth (Tauri app)                    React/TS WebView  ── invoke / Channel / events ──┐
  src-tauri/  commands, AppState, booth:// protocol, capabilities                           │
        │                                                                                    ▼
        ├── crates/photobooth-core   Camera trait · Session FSM · Settings · PhotoStore · MockCamera
        ├── crates/sony-ptp          PTP + Sony SDIO engine · Transport trait · Replay/Recording
        └── plugins/tauri-plugin-photobooth-camera
                 Kotlin: CameraX (behind transparent WebView), USB host, window flags
                 Rust:   NativeCamera (impl Camera), AndroidUsbTransport (impl Transport)
```

Data flow for a capture: the FSM asks the active `Camera` to `capture()`, the JPEG goes
into `PhotoStore` keyed `(session_id, shot)`, the FSM emits `session://state`, and the
WebView renders `<img src="booth://photo/<session>/<shot>">`. Bytes never cross IPC as
base64/JSON.

## The five deliverables

| Piece | Public surface (pinned in the per-step pages) |
|-------|-----------------------------------------------|
| `photobooth-core` | `Camera` trait, `CameraId` newtype, `CameraStatus`, `CameraError`, `Session`/`SessionState`, `StartTrigger`, `Settings`, `PhotoStore`, `MockCamera` + `MockCameraHandle` |
| `sony-ptp` | `Transport` trait, `PtpSession`/`SonyCamera<T>`, `RusbTransport` (`desktop-usb`), `ReplayTransport`/`RecordingTransport`, optional `core-camera` adapter |
| `tauri-plugin-photobooth-camera` | Kotlin commands (`usb*`, `cam*`, `window*`, permissions), Rust `NativeCamera`, `AndroidUsbTransport`, typed `guest-js` |
| `apps/booth/src-tauri` | Commands: `camera_list`, `camera_select`, `camera_connect`, `camera_disconnect`, `live_view_start/stop`, `session_start/cancel/take_another/return_home`, `settings_get/set`, `test_inject`, `logs_recent`; events `camera://status`, `session://state` |
| `apps/booth` frontend | `CameraSelect`, `Booth`, `Settings`, `DevPanel` screens; typed `src/ipc`; Zustand store fed only by IPC events |

## Phased delivery

1. **Spikes** — settle the risky unknowns first (USB fd handoff, CameraX behind WebView).
2. **Skeleton + test mode** — core crate, scaffold, frontend, mock camera end to end.
3. **Native camera** — CameraX plugin.
4. **Wired camera** — PTP engine, then the Android USB transport.
5. **Hardening** — on-device checklists, fault injection, Maestro retarget.
6. **Cutover** — retire the KMP targets once parity is confirmed on the rig.

## Risks

- **USB fd permission flow on Android.** The USB grant lives on Kotlin's
  `UsbDeviceConnection`, not on the fd integer; closing the connection while Rust still
  holds a dup'd fd breaks libusb. Mitigated by a documented drop order (Rust transport
  first, then `usbClose`).
- **CameraX behind the WebView.** Requires a transparent WebView and correct z-order;
  the React overlay must not paint an opaque background over the preview.
- **Live view over IPC.** Raw-byte `Channel` with keep-latest-frame semantics; throughput
  on the tablet is unmeasured until run on device.
- **Sony USB live view is flaky on A7-generation bodies** (freezes after ~30 s, one
  capture then stalls — widely reported against libgphoto2). Live view is best-effort
  behind a watchdog; the capture path must never depend on it.

## Environment deviations from the handoff guide

The handoff guide assumed a Mac with the Sony A7 III plugged into the dev machine and a
Samsung tablet. This build ran on **Windows 11 with a Xiaomi tablet**, and the camera is
cabled to the **tablet**, not the dev machine. Consequences:

- The planned "develop the PTP engine against the real camera on the desktop" checkpoint
  is not available. The engine is instead developed against byte-level fixtures
  (`ReplayTransport`), and the first real-hardware verification happens **through the
  Android app** via the USB-fd path. See `Wired-Camera-Protocol.md` for what is and is
  not verified on hardware.
- Windows needs a WinUSB driver swap to talk to the camera from `rusb`; that is not done
  here and `desktop-usb` is therefore compile-and-unit-tested only on this machine.
