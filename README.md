# Photobooth

A photobooth for Android tablets, built with Tauri v2: a Rust core that owns all business logic, a React
WebView that only renders state, and one Android plugin for the camera hardware. It takes photos from a
wired Sony A7 III (PTP over USB), the tablet's own camera, or a built-in test camera.

Photos are never written to disk; they live in memory for one session.

| Path | What |
|------|------|
| `crates/photobooth-core` | `Camera` trait, session state machine, settings, photo store, mock camera |
| `crates/sony-ptp` | Sony A7 III over PTP/USB |
| `plugins/tauri-plugin-photobooth-camera` | Kotlin CameraX + USB host, Rust `NativeCamera` |
| `apps/booth` | The Tauri app and its React UI (bun only) |
| `wiki/` | Design decisions and how the pieces fit; start at [wiki/README.md](./wiki/README.md) |

## Build

See [wiki/Android-Build.md](./wiki/Android-Build.md). In short, on Windows with PowerShell 7:

```shell
cd apps/booth && bun install --frozen-lockfile
pwsh apps/booth/scripts/build-android-debug.ps1 -Install
```

The pre-commit checks are listed in [CLAUDE.md](./CLAUDE.md).
