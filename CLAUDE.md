# CLAUDE.md

Tauri v2 photobooth for Android tablets: a Rust core, a React WebView, and one Android camera plugin.

## Layout

| Path | What |
|------|------|
| `crates/photobooth-core` | `Camera` trait, session FSM, settings, in-memory photo store, mock camera (pure Rust) |
| `crates/sony-ptp` | Sony A7 III over PTP/USB, `Transport` trait, replay/recording |
| `plugins/tauri-plugin-photobooth-camera` | Kotlin CameraX + USB host, Rust `NativeCamera` |
| `apps/booth/src-tauri` | Tauri app: commands, `AppState`, `booth://` protocol, capabilities, `gen/android` (committed, hand-edited) |
| `apps/booth` | React 19 + TS UI, **bun only** (no npm, no Vite) |
| `composeApp/`, `iosApp/`, `.maestro/flows/` | Legacy Kotlin Multiplatform app. Frozen until cutover; don't change it unless asked |

## Check before committing (same as CI)

```bash
cargo fmt --all -- --check
cargo clippy -p <crate> --all-targets --all-features -- -D warnings   # no allow() suppressions
cargo test -p <crate>
cd apps/booth && bun run typecheck && bun test && bun run build
```

The `photobooth` crate embeds `apps/booth/dist`, so run `bun run build` before building or testing it.

## Rules

- Business logic lives in Rust. The WebView only renders state and sends intent.
- Never write photos to disk. They stay in `PhotoStore` memory for one session.
- `test_inject` and `logs_recent` are available only through the `dev` capability.
- Use `bun x tauri …`, not `bun run tauri` (it panics in `android init`).
- If you change something hardware-facing, update its wiki page and label anything not run on the tablet as unverified.

## Docs

Read `wiki/` only for the area you're touching. It holds the reasons behind decisions, not structure:
`Tauri-Migration-Plan.md` (settled decisions, don't re-argue them), `Tauri-Workstreams.md` (contracts),
`Android-Build.md`, `Frontend.md`, `Tauri-App.md`, `Core-Domain.md`, `Wired-Camera-Protocol.md`, `Native-Camera-Plugin.md`.

## Device Testing (Windows PC + Xiaomi tablet)

When developing on the Windows PC with the Xiaomi Pad 6 (`adb devices -l` shows `device:pipa`), this is the
suggested way to test on the device. The aim is to test without the user stepping in. Rationale:
`wiki/Android-Build.md` → "adb over Wi-Fi".

- **Connect over Wi-Fi, not USB.** The Sony is cabled to the tablet's only USB-C port, so adb uses Android
  Wireless debugging (already paired with this PC). Run `pwsh apps/booth/scripts/connect-tablet.ps1` first.
  Don't ask the user to swap cables.
- **Can't find the tablet?** Ask the user to turn on Settings → Additional settings → Developer options →
  Wireless debugging. Re-pair (`-Pair <code>`) only for a new PC. Don't `adb connect ip:port` by hand: it
  races adb's mDNS auto-connect, lists the tablet twice, and every plain `adb` command then fails.
- `adb` is not on PATH: `$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe`.
- **Build + install:** `pwsh apps/booth/scripts/build-android-debug.ps1 -Install` (PowerShell 7). It connects first.
- **Drive the app with plain adb, not Maestro.** Use `exec-out screencap -p`, `shell input tap x y`
  (2880×1800 landscape), `input keyevent`, `am start -n com.jc.photobooth.tauri/com.jc.photobooth.MainActivity`,
  `uiautomator dump`, `logcat -s Photobooth` and `run-as com.jc.photobooth.tauri`. Maestro makes MIUI show an
  "Install via USB" prompt on every run, so keep Maestro (`.maestro/tauri/`) for CI and emulators.
- **Never uninstall `com.jc.photobooth`** (the user's Kotlin app, different signing key). The Tauri debug
  build is `com.jc.photobooth.tauri`.
